-- init.sql

-- 1. Create Tables
CREATE TABLE movies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    duration_mins INT
);

CREATE TABLE theatres (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL
);

CREATE TABLE showtimes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movie_id UUID REFERENCES movies(id),
    theatre_id UUID REFERENCES theatres(id),
    start_time TIMESTAMP NOT NULL,
    price INT NOT NULL,
    currency VARCHAR(3) DEFAULT 'BDT'
);

CREATE TABLE seats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    showtime_id UUID REFERENCES showtimes(id),
    seat_number VARCHAR(10) NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE', -- 'AVAILABLE', 'HELD', 'BOOKED'
    hold_expires_at TIMESTAMP NULL,
    booking_ref VARCHAR(255) NULL,
    UNIQUE(showtime_id, seat_number)
);

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_ref VARCHAR(255) UNIQUE NOT NULL,
    payment_id VARCHAR(255) UNIQUE, -- Can be null initially if gateway times out
    amount INT NOT NULL,
    currency VARCHAR(3) DEFAULT 'BDT',
    status VARCHAR(50) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Crucial for the gateway duplicate callback defense
CREATE TABLE processed_webhooks (
    event_id VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT NOW()
);

-- 2. Insert Seed Data

-- Insert Movie
INSERT INTO movies (id, title, description, duration_mins) 
VALUES ('a1111111-1111-1111-1111-111111111111', 'Spider-Man: Brand New Day', 'The highly anticipated midnight premiere.', 145);

-- Insert Theatre
INSERT INTO theatres (id, name, location) 
VALUES ('b2222222-2222-2222-2222-222222222222', 'Grand Cinema', 'Downtown Mall');

-- Insert Showtime
INSERT INTO showtimes (id, movie_id, theatre_id, start_time, price, currency) 
VALUES ('c3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', '2026-08-08 20:00:00', 500, 'BDT');

-- Insert Seats
INSERT INTO seats (showtime_id, seat_number, status) VALUES 
('c3333333-3333-3333-3333-333333333333', 'F10', 'AVAILABLE'),
('c3333333-3333-3333-3333-333333333333', 'F11', 'AVAILABLE'),
('c3333333-3333-3333-3333-333333333333', 'F12', 'AVAILABLE'), 
('c3333333-3333-3333-3333-333333333333', 'F13', 'AVAILABLE'),
('c3333333-3333-3333-3333-333333333333', 'F14', 'AVAILABLE');
