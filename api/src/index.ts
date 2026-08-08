import { Elysia } from "elysia";
import postgres from "postgres";

const PORT = process.env.PORT || 8080;
// 1. Default to 'gateway:9000' for Docker container networking
const GATEWAY_URL = process.env.GATEWAY_URL || "http://gateway:9000"; 
// 2. Default to 60 seconds so manual testing gives enough time to type the OTP
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || "60", 10); 
const DB_URL = process.env.DB_URL || "postgres://cinema:cinema_password@db:5432/cinemadb";

const sql = postgres(DB_URL, {
  max: 20
});

const app = new Elysia();

// ==========================================
// 1. JUDGING HOOK (Healthcheck)
// ==========================================
app.get("/health", () => {
  return new Response("OK", { status: 200 });
});

// ==========================================
// 2. MOVIES & SEATS
// ==========================================
app.get("/api/movies", async () => {
  try {
    const movies = await sql`SELECT * FROM movies`;
    return { movies };
  } catch (error) {
    console.error("Database error:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
  }
});

app.get("/api/shows/:show_id/seats", async ({ params }) => {
  try {
    const seats = await sql`
      SELECT id, seat_number, status 
      FROM seats 
      WHERE showtime_id = ${params.show_id}
      ORDER BY seat_number ASC
    `;
    return {
      show_id: params.show_id,
      seats
    };
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to fetch seats" }), { status: 500 });
  }
});

// ==========================================
// 3. HOLD SEAT & SEND OTP
// ==========================================
app.post("/api/hold", async ({ body }) => {
  const { show_id, seat_id, phone } = body as any;
  
  const booking_ref = `bk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  try {
    const isSuccess = await sql.begin(async (tx) => {
      const lockedSeats = await tx`
        SELECT id FROM seats 
        WHERE seat_number = ${seat_id} 
          AND showtime_id = ${show_id} 
          AND status = 'AVAILABLE' 
        FOR UPDATE SKIP LOCKED
      `;

      if (lockedSeats.length === 0) {
        return false; 
      }

      await tx`
        UPDATE seats 
        SET status = 'HELD', 
            hold_expires_at = NOW() + (${HOLD_TTL_SECONDS} * INTERVAL '1 second'),
            booking_ref = ${booking_ref}
        WHERE seat_number = ${seat_id} 
          AND showtime_id = ${show_id}
      `;

      return true;
    });

    if (!isSuccess) {
      return new Response(JSON.stringify({ error: "Seat is already held or booked" }), { 
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (dbError) {
    console.error("Transaction Error:", dbError);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Call Gateway to send OTP (Must succeed so gateway records the ref)
  try {
    const otpSendRes = await fetch(`${GATEWAY_URL}/otp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, ref: booking_ref }),
    });

    console.log(`📡 [GATEWAY /otp/send] Ref: ${booking_ref} | Status: ${otpSendRes.status}`);
  } catch (err) {
    console.error("📡 [GATEWAY ERROR] /otp/send unreachable:", err);
  }

  return new Response(JSON.stringify({ 
    message: "Seat held, OTP sent", 
    seat_id, 
    booking_ref 
  }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});

// ==========================================
// 4. VERIFY OTP & PAY
// ==========================================
app.post("/api/pay", async ({ body }) => {
  const { booking_ref, otp_code, amount, currency, callback_url } = body as any;

  // 1. Verify OTP with Gateway
  try {
    const otpRes = await fetch(`${GATEWAY_URL}/otp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: booking_ref, code: otp_code }),
    });

    const otpBody = await otpRes.text();
    console.log(`📡 [GATEWAY /otp/verify] Ref: ${booking_ref} | Status: ${otpRes.status} | Response: ${otpBody}`);

    if (!otpRes.ok) {
      return new Response(JSON.stringify({ error: "Invalid or expired OTP. Please try again." }), { 
        status: 400, headers: { 'Content-Type': 'application/json' } 
      });
    }
  } catch (error) {
    console.error("Gateway /otp/verify unreachable:", error);
    return new Response(JSON.stringify({ error: "OTP Service down, please try again" }), { 
      status: 502, headers: { 'Content-Type': 'application/json' } 
    });
  }

  // 2. Fallback callback_url for internal container routing
  const finalCallbackUrl = callback_url || "http://api:8080/api/callback";

  // 3. Initiate Charge with Gateway
  let chargeData;
  try {
    const chargeRes = await fetch(`${GATEWAY_URL}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        amount: amount || 500, 
        currency: currency || "BDT", 
        booking_ref, 
        callback_url: finalCallbackUrl 
      }),
    });

    if (!chargeRes.ok) {
      return new Response(JSON.stringify({ error: "Payment gateway busy. Please retry." }), { 
        status: 502, headers: { 'Content-Type': 'application/json' } 
      });
    }

    chargeData = await chargeRes.json();
  } catch (error) {
    console.error("Gateway /charge unreachable or timed out:", error);
    return new Response(JSON.stringify({ error: "Payment Gateway timeout. Please retry." }), { 
      status: 504, headers: { 'Content-Type': 'application/json' } 
    });
  }

  // 4. Record Payment Intent
  try {
    await sql`
      INSERT INTO payments (booking_ref, payment_id, amount, currency, status)
      VALUES (
        ${booking_ref}, 
        ${chargeData.payment_id}, 
        ${amount || 500}, 
        ${currency || 'BDT'}, 
        ${chargeData.status}
      )
      ON CONFLICT (booking_ref) 
      DO UPDATE SET 
        payment_id = ${chargeData.payment_id},
        status = ${chargeData.status}
    `;
  } catch (dbError) {
    console.error("Failed to save payment record:", dbError);
    return new Response(JSON.stringify({ error: "Failed to record payment" }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }

  return new Response(JSON.stringify({
    message: "Payment processing initiated. Waiting for confirmation.",
    payment_id: chargeData.payment_id,
    status: chargeData.status
  }), { 
    status: 202,
    headers: { 'Content-Type': 'application/json' } 
  });
});

// ==========================================
// 5. CANCEL / RELEASE HOLD
// ==========================================
app.post("/api/release", async ({ body }) => {
  const { booking_ref } = body as any;

  if (booking_ref) {
    try {
      await sql`
        UPDATE seats 
        SET status = 'AVAILABLE', 
            hold_expires_at = NULL, 
            booking_ref = NULL 
        WHERE booking_ref = ${booking_ref} AND status = 'HELD'
      `;
      console.log(`🔓 [CANCEL] Instantly released seat for booking ref: ${booking_ref}`);
    } catch (err) {
      console.error("Error releasing seat:", err);
    }
  }

  return new Response(JSON.stringify({ message: "Seat hold released" }), { status: 200 });
});

// ==========================================
// 6. GATEWAY CALLBACK (Webhook)
// ==========================================
app.post("/api/callback", async ({ body }) => {
  const payload = body as any;
  const { event_id, payment_id, booking_ref, status } = payload;

  console.log(`📩 [CALLBACK] Event: ${event_id} | Ref: ${booking_ref} | Status: ${status}`);

  if (!event_id || !booking_ref) {
    return new Response("Malformed payload ignored", { status: 200 });
  }

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO processed_webhooks (event_id) 
        VALUES (${event_id})
      `;

      await tx`
        UPDATE payments 
        SET status = ${status}, 
            payment_id = COALESCE(${payment_id}, payment_id)
        WHERE booking_ref = ${booking_ref}
      `;

      if (status === "SUCCEEDED") {
        await tx`
          UPDATE seats 
          SET status = 'BOOKED', 
              hold_expires_at = NULL 
          WHERE booking_ref = ${booking_ref}
        `;
        console.log(`✅ [BOOKED] Seat permanently booked for ${booking_ref}`);

      } else if (status === "FAILED" || status === "REFUNDED") {
        await tx`
          UPDATE seats 
          SET status = 'AVAILABLE', 
              hold_expires_at = NULL, 
              booking_ref = NULL 
          WHERE booking_ref = ${booking_ref}
        `;
        console.log(`❌ [RELEASED] Released seat back to pool for ${booking_ref}`);
      }
    });

  } catch (err: any) {
    if (err.code === "23505") {
      console.log(`⚠️ [DUPLICATE CALLBACK] Event ${event_id} already processed. Returning 200.`);
      return new Response("Duplicate callback ignored", { status: 200 });
    }
    console.error("Error processing callback DB transaction:", err);
    return new Response("Callback error handled", { status: 200 });
  }

  return new Response("Callback processed successfully", { status: 200 });
});

// ==========================================
// 7. BACKGROUND HOLD CLEANUP WORKER
// ==========================================
setInterval(async () => {
  try {
    const releasedSeats = await sql`
      UPDATE seats 
      SET status = 'AVAILABLE', 
          hold_expires_at = NULL, 
          booking_ref = NULL
      WHERE status = 'HELD' 
        AND hold_expires_at <= NOW()
      RETURNING seat_number, showtime_id;
    `;

    if (releasedSeats.length > 0) {
      const seatsList = releasedSeats.map(s => s.seat_number).join(", ");
      console.log(`⏱️ [AUTO-RELEASE] TTL Expired. Returned to available: ${seatsList}`);
    }
  } catch (error) {
    console.error("Error in background hold cleanup worker:", error);
  }
}, 2000);

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`🦊 CinemaSeat API is running at http://localhost:${PORT}`);
  console.log(`⏱️  Hold TTL is set to ${HOLD_TTL_SECONDS} seconds`);
});