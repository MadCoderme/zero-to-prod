# 📐 Architectural & Engineering Decisions

During the 8-hour sprint building **CinemaSeat**, our team debated several trade-offs. Below are the three key technical decisions, the options considered, our choices, and what we sacrificed.

---

### Decision 1: Modular Monolith vs. Microservices Architecture

* **Options Considered:**
  1. *Microservices:* Separate services for Movies Catalog, Seat Holding, Payment Processing, and Webhook Callbacks.
  2. *Modular Monolith:* A single containerized Bun TypeScript application containing clean module boundaries, backed by PostgreSQL and Nginx.
* **What We Chose:** **Modular Monolith**.
* **Why:** Under an 8-hour hackathon constraint, distributed microservices introduce massive latency penalties (network hops between containers), complex distributed tracing requirements, and partial failure modes. A modular monolith allows in-memory function execution for core paths while maintaining service isolation behind Nginx.
* **What We Gave Up:** Independent scalability. If seat holding experiences an intense spike, the movie browsing module shares the same container memory space (mitigated by Nginx caching and rate limiting).

---

### Decision 2: Pessimistic Database Row Locking (`FOR UPDATE SKIP LOCKED`) vs. In-Memory Redis Caching

* **Options Considered:**
  1. *Redis Distributed Lock / Atomic Counters:* Store seat state in Redis (`SET NX EX`) to handle holds in memory before flushing to the DB.
  2. *PostgreSQL Pessimistic Row Locking (`FOR UPDATE SKIP LOCKED`):* Execute seat hold selection directly inside a PostgreSQL transaction using row-level locking.
* **What We Chose:** **PostgreSQL Pessimistic Row Locking (`FOR UPDATE SKIP LOCKED`)**.
* **Why:** Redis locks introduce dual-write inconsistencies (what happens if Redis holds the seat but Postgres fails to save the booking?). PostgreSQL ACID transactions guarantee absolute correctness. Using `SKIP LOCKED` instructs Postgres to immediately skip rows locked by concurrent transactions, allowing 99 out of 100 competing requests to fail fast with `409 Conflict` in under 2ms without blocking the database.
* **What We Gave Up:** Pure in-memory throughput speed. Hitting PostgreSQL directly uses DB CPU cycles during extreme concurrency bursts, but guarantees **zero double-booking**.

---

### Decision 3: Database Primary Key Constraints vs. Memory Cache for Webhook Callback Idempotency

* **Options Considered:**
  1. *In-Memory Set / LRU Cache:* Store processed `event_id` keys in API process memory.
  2. *PostgreSQL `processed_webhooks` Table with UNIQUE Primary Key:* Store every received `event_id` in a dedicated relational table.
* **What We Chose:** **PostgreSQL `processed_webhooks` Table (`event_id PRIMARY KEY`)**.
* **Why:** The provided payment gateway delivers duplicate callbacks 8% of the time. In-memory caches are wiped if the container restarts or if traffic is load-balanced across multiple instances. By inserting `event_id` inside the same database transaction as the seat booking update, Postgres catches duplicate deliveries via SQLState `23505` (Unique Constraint Violation), allowing our callback handler to return `200 OK` instantly while preventing double revenue counts or duplicate booking confirmations.
* **What We Gave Up:** A small database write overhead per webhook callback, in exchange for 100% crash-resilient idempotency.