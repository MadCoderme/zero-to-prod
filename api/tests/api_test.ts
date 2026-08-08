// tests/api.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import postgres from "postgres";

const API_URL = process.env.API_URL || "http://localhost:8080";
const DB_URL = process.env.DB_URL || "postgres://cinema:cinema_password@localhost:5432/cinemadb";

const sql = postgres(DB_URL);

describe("CinemaSeat API Core Logic Tests", () => {
  
  // Clean up the database state before running tests
  beforeAll(async () => {
    // Reset seat F12 to AVAILABLE
    await sql`
      UPDATE seats 
      SET status = 'AVAILABLE', hold_expires_at = NULL, booking_ref = NULL 
      WHERE seat_number = 'F12' AND showtime_id = 'c3333333-3333-3333-3333-333333333333'
    `;
    
    // Clear processed webhooks and payments for clean testing
    await sql`DELETE FROM processed_webhooks`;
    await sql`DELETE FROM payments`;
  });

  // ===================================================
  // 1. HEALTH CHECK TEST
  // ===================================================
  test("GET /health should return 200 in under 1 second", async () => {
    const start = performance.now();
    
    const res = await fetch(`${API_URL}/health`);
    const duration = performance.now() - start;

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(duration).toBeLessThan(1000); // Must be under 1000ms
  });

  // ===================================================
  // 2. MOVIES & SEAT MAP TEST
  // ===================================================
  test("GET /api/movies should return populated movies list", async () => {
    const res = await fetch(`${API_URL}/api/movies`);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.movies).toBeArray();
    expect(data.movies.length).toBeGreaterThan(0);
    expect(data.movies[0].title).toBe("Spider-Man: Brand New Day");
  });

  // ===================================================
  // 3. SCENARIO A: 100 CONCURRENT USERS FIGHT FOR SEAT F12
  // ===================================================
  test("Scenario A: 100 concurrent requests for seat F12 -> Exactly 1 success, 99 rejections", async () => {
    
    // Create 100 distinct request promises for the EXACT same seat at the exact same moment
    const requests = Array.from({ length: 100 }, (_, i) => 
      fetch(`${API_URL}/api/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          show_id: "c3333333-3333-3333-3333-333333333333",
          seat_id: "F12", // The battleground seat
          phone: `+8801700000${i.toString().padStart(3, '0')}`
        })
      })
    );

    // Fire all 100 requests concurrently
    const responses = await Promise.all(requests);
    const statuses = responses.map(r => r.status);

    // Count how many succeeded (200) vs rejected (409 Conflict)
    const successes = statuses.filter(s => s === 200).length;
    const conflicts = statuses.filter(s => s === 409).length;

    console.log(`\n📊 [SCENARIO A TEST RESULTS]`);
    console.log(`   - Total Requests: 100`);
    console.log(`   - Successful Holds (200 OK): ${successes}`);
    console.log(`   - Clean Rejections (409 Conflict): ${conflicts}`);
    console.log(`   - Oversell Count: ${successes > 1 ? successes - 1 : 0}\n`);

    // ASSERTIONS REQUIRED BY THE JUDGES:
    expect(successes).toBe(1);   // EXACTLY 1 request must succeed
    expect(conflicts).toBe(99);  // EXACTLY 99 must be rejected

    // Verify database state: Seat F12 must be 'HELD' exactly once
    const dbSeat = await sql`
      SELECT status, booking_ref FROM seats WHERE seat_number = 'F12' AND showtime_id = 'c3333333-3333-3333-3333-333333333333'
    `;
    expect(dbSeat[0].status).toBe("HELD");
    expect(dbSeat[0].booking_ref).not.toBeNull();
  });

  // ===================================================
  // 4. PREVENT RE-HOLDING AN ALREADY HELD SEAT
  // ===================================================
  test("Subsequent hold on already held seat should fail immediately with 409", async () => {
    const res = await fetch(`${API_URL}/api/hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        show_id: "c3333333-3333-3333-3333-333333333333",
        seat_id: "F12",
        phone: "+8801999999999"
      })
    });

    expect(res.status).toBe(409);
  });

  // ===================================================
  // 5. SCENARIO B: THE ABANDONED HOLD (TTL EXPIRY)
  // ===================================================
  test("Scenario B: Abandoned hold automatically expires and returns to AVAILABLE", async () => {
    
    // 1. Hold seat F11
    const holdRes = await fetch(`${API_URL}/api/hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        show_id: "c3333333-3333-3333-3333-333333333333",
        seat_id: "F11",
        phone: "+8801711111111"
      })
    });
    expect(holdRes.status).toBe(200);

    // 2. Immediately verify the seat is 'HELD' in DB
    let seatInDb = await sql`SELECT status FROM seats WHERE seat_number = 'F11' AND showtime_id = 'c3333333-3333-3333-3333-333333333333'`;
    expect(seatInDb[0].status).toBe("HELD");

    console.log("   - Seat F11 successfully held. Simulating user walking away without paying...");

    // 3. Wait for HOLD_TTL_SECONDS + buffer (e.g., if HOLD_TTL_SECONDS is 3s locally, wait 5s)
    // Adjust wait time based on your local HOLD_TTL_SECONDS setting
    const ttlSeconds = parseInt(process.env.HOLD_TTL_SECONDS || "3", 10);
    const waitMs = (ttlSeconds + 3) * 1000;
    
    console.log(`   - Waiting ${waitMs / 1000} seconds for background worker to clear it...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));

    // 4. Check DB to ensure it was released by the background worker
    seatInDb = await sql`SELECT status FROM seats WHERE seat_number = 'F11' AND showtime_id = 'c3333333-3333-3333-3333-333333333333'`;
    expect(seatInDb[0].status).toBe("AVAILABLE");

    // 5. Verify a DIFFERENT user can now successfully book seat F11
    const secondUserHold = await fetch(`${API_URL}/api/hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        show_id: "c3333333-3333-3333-3333-333333333333",
        seat_id: "F11",
        phone: "+8801722222222" // Different user
      })
    });
    expect(secondUserHold.status).toBe(200);

    console.log("   - Success! Seat returned to AVAILABLE and was booked by a second user.\n");
  }, 15000); // Increase test timeout to 15s to allow for waiting

  // ===================================================
  // 6. DUPLICATE CALLBACK IDEMPOTENCY TEST
  // ===================================================
  test("Duplicate callback should return 200 and not process twice", async () => {
    
    // 1. First, hold seat F13 to get a valid booking_ref
    const holdRes = await fetch(`${API_URL}/api/hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        show_id: "c3333333-3333-3333-3333-333333333333",
        seat_id: "F13",
        phone: "+8801888888888"
      })
    });
    const holdData = await holdRes.json() as any;
    const booking_ref = holdData.booking_ref;

    // Create a mock callback payload
    const mockCallbackPayload = {
      event_id: `evt_test_${Date.now()}`, // Unique event ID
      payment_id: `pay_test_${Date.now()}`,
      booking_ref: booking_ref,
      status: "SUCCEEDED",
      amount: 500
    };

    // 2. Send FIRST callback -> Should process cleanly
    const cb1 = await fetch(`${API_URL}/api/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mockCallbackPayload)
    });
    expect(cb1.status).toBe(200);

    // Verify seat F13 is now 'BOOKED' in DB
    let seat = await sql`SELECT status FROM seats WHERE seat_number = 'F13' AND showtime_id = 'c3333333-3333-3333-3333-333333333333'`;
    expect(seat[0].status).toBe("BOOKED");

    // 3. Send DUPLICATE callback (Same payload & event_id) -> Must return 200 OK without crashing
    const cb2 = await fetch(`${API_URL}/api/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mockCallbackPayload)
    });
    expect(cb2.status).toBe(200);

    // Verify seat F13 is STILL 'BOOKED' and wasn't altered
    seat = await sql`SELECT status FROM seats WHERE seat_number = 'F13' AND showtime_id = 'c3333333-3333-3333-3333-333333333333'`;
    expect(seat[0].status).toBe("BOOKED");

    console.log("   - Idempotency test passed! Duplicate callback safely ignored.");
  });
});