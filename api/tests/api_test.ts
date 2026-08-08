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
});