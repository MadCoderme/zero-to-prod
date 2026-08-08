import { Elysia } from "elysia";
import postgres from "postgres";

const PORT = process.env.PORT || 8080;
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:9000";
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || "3", 10); 
const DB_URL = process.env.DB_URL || "postgres://cinema:cinema_password@db:5432/cinemadb";

const sql = postgres(DB_URL, {
  max: 20
});

const app = new Elysia();


app.get("/health", () => {
  return new Response("OK", { status: 200 });
});

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

app.post("/api/hold", async ({ body }) => {
  const { show_id, seat_id, phone } = body as any;
  
  // 1. Generate the ref FIRST so we can save it to the database
  const booking_ref = `bk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  try {
    const isSuccess = await sql.begin(async (tx) => {
      
      // Attempt to lock the seat. 
      const lockedSeats = await tx`
        SELECT id FROM seats 
        WHERE seat_number = ${seat_id} 
          AND showtime_id = ${show_id} 
          AND status = 'AVAILABLE' 
        FOR UPDATE SKIP LOCKED
      `;

      // If length is 0, someone else got the lock first.
      if (lockedSeats.length === 0) {
        return false; 
      }

      // We got the lock! Update the seat.
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

    // 3. Handle the scenario where they lost the "seat fight"
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

  // 4. Call the Mock Gateway to send OTP
  try {
    await fetch(`${GATEWAY_URL}/otp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, ref: booking_ref }),
    });
  } catch (err) {
    console.error("Gateway /otp/send failed", err);
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

app.post("/api/pay", async ({ body }) => {
  const { booking_ref, otp_code, amount, currency, callback_url } = body as any;

  // 1. Verify OTP with Gateway
  try {
    const otpRes = await fetch(`${GATEWAY_URL}/otp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: booking_ref, code: otp_code }),
    });

    if (!otpRes.ok) {
      return new Response(JSON.stringify({ error: "Invalid or expired OTP" }), { 
        status: 400, headers: { 'Content-Type': 'application/json' } 
      });
    }
  } catch (error) {
    console.error("Gateway /otp/verify unreachable:", error);
    return new Response(JSON.stringify({ error: "OTP Service down, please try again" }), { 
      status: 502, headers: { 'Content-Type': 'application/json' } 
    });
  }

  // 2. Initiate Charge with Gateway
  let chargeData;
  try {
    const chargeRes = await fetch(`${GATEWAY_URL}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Note: In local testing, callback_url should be your machine's IP, 
      // or "http://api:8080/api/callback" if testing entirely inside Docker network
      body: JSON.stringify({ amount, currency, booking_ref, callback_url }),
    });

    if (!chargeRes.ok) {
      // The gateway randomly returns 500s. We must handle this gracefully.
      return new Response(JSON.stringify({ error: "Payment gateway failed to initialize. Please retry." }), { 
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

  // 3. Save the Payment Intent to the Database
  try {
    await sql`
      INSERT INTO payments (booking_ref, payment_id, amount, currency, status)
      VALUES (
        ${booking_ref}, 
        ${chargeData.payment_id}, 
        ${amount}, 
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

  // 4. Return success to the user immediately. 
  // We do NOT wait for the callback here!
  return new Response(JSON.stringify({
    message: "Payment processing initiated. Waiting for confirmation.",
    payment_id: chargeData.payment_id,
    status: chargeData.status // This will usually be "PENDING"
  }), { 
    status: 202, // 202 Accepted is the correct HTTP status for async processing
    headers: { 'Content-Type': 'application/json' } 
  });
});

// ==========================================
// 5. GATEWAY CALLBACK (Webhook)
// ==========================================
app.post("/api/callback", async ({ body }) => {
  const payload = body as any;
  const { event_id, payment_id, booking_ref, status, amount } = payload;

  console.log(`📩 [CALLBACK RECEIVED] Event: ${event_id} | Ref: ${booking_ref} | Status: ${status}`);

  if (!event_id || !booking_ref) {
    console.warn("Received malformed callback payload:", payload);
    return new Response("Malformed payload ignored", { status: 200 });
  }

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO processed_webhooks (event_id) 
        VALUES (${event_id})
      `;

      // UPDATE PAYMENT RECORD
      await tx`
        UPDATE payments 
        SET status = ${status}, 
            payment_id = COALESCE(${payment_id}, payment_id)
        WHERE booking_ref = ${booking_ref}
      `;

      // UPDATE SEAT STATUS BASED ON OUTCOME
      if (status === "SUCCEEDED") {
        await tx`
          UPDATE seats 
          SET status = 'BOOKED', 
              hold_expires_at = NULL 
          WHERE booking_ref = ${booking_ref}
        `;
        console.log(`✅ [BOOKING CONFIRMED] Seat permanently booked for ${booking_ref}`);

      } else if (status === "FAILED" || status === "REFUNDED") {
        await tx`
          UPDATE seats 
          SET status = 'AVAILABLE', 
              hold_expires_at = NULL, 
              booking_ref = NULL 
          WHERE booking_ref = ${booking_ref}
        `;
        console.log(`❌ [PAYMENT FAILED] Released seat back to pool for ${booking_ref}`);
      }
    });

  } catch (err: any) {
    if (err.code === "23505") {
      console.log(`⚠️ [DUPLICATE CALLBACK IGNORED] Event ${event_id} already processed. Returning 200.`);
      return new Response("Duplicate callback ignored", { status: 200 });
    }
    console.error("Error processing callback DB transaction:", err);
    return new Response("Callback error handled", { status: 200 });
  }

  // Always return 200 OK
  return new Response("Callback processed successfully", { status: 200 });
});

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