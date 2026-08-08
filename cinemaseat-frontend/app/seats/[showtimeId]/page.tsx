"use client";
import { useParams, useRouter } from "next/navigation";
import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function SelectionPage() {
  const { showtimeId } = useParams();
  const router = useRouter();

  // API State
  const [seats, setSeats] = useState<any[]>([]);
  const [bookingRef, setBookingRef] = useState("");
  
  // UI State
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<'map' | 'otp' | 'processing' | 'success'>('map');
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(60); // 60s Hold Timer
  const [errorMessage, setErrorMessage] = useState("");

  // 1. POLL SEAT MAP (Every 2 seconds) + Detect Payment Success/Failure
  useEffect(() => {
    const fetchSeats = async () => {
      try {
        const res = await fetch(`/api/shows/${showtimeId}/seats`);
        const data = await res.json();
        setSeats(data?.seats || []);

        if (selectedSeat) {
          const mySeat = data?.seats?.find((s: any) => s.seat_number === selectedSeat);
          
          // Case A: Payment Succeeded!
          if (mySeat?.status === 'BOOKED' && step === 'processing') {
            setStep('success');
          }
          
          // Case B: Payment Failed or Hold Expired while processing!
          if (mySeat?.status === 'AVAILABLE' && step === 'processing') {
            setErrorMessage("Payment failed or hold expired. Please try again.");
            setStep('map');
            setSelectedSeat(null);
          }
        }
      } catch (err) {
        console.error("Failed to poll seats", err);
      }
    };

    fetchSeats();
    const interval = setInterval(fetchSeats, 2000);
    return () => clearInterval(interval);
  }, [showtimeId, selectedSeat, step]);

  // 2. HOLD TIMER COUNTDOWN
  useEffect(() => {
    if (step !== 'otp') return;
    
    setTimeLeft(60); // Reset to 60s when reaching OTP step
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleCancel("Hold expired! Please re-select your seat.");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [step]);

  // 3. CANCEL & INSTANTLY RELEASE SEAT
  const handleCancel = async (customErrorMsg?: string) => {
    if (bookingRef) {
      try {
        // Explicitly tell PostgreSQL to release this seat immediately
        await fetch('/api/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_ref: bookingRef })
        });
      } catch (err) {
        console.error("Failed to release seat on cancel", err);
      }
    }

    setStep('map');
    setSelectedSeat(null);
    setBookingRef("");
    setOtp("");
    if (customErrorMsg) setErrorMessage(customErrorMsg);
  };

  // 4. HOLD SEAT & SEND OTP
  const handleHold = async (seatNum: string) => {
    if (!phone) {
      setErrorMessage("Please enter your phone number first.");
      return;
    }
    setErrorMessage("");
    setLoading(true);
    try {
      const res = await fetch('/api/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_id: showtimeId, seat_id: seatNum, phone })
      });
      const data = await res.json();

      if (res.ok) {
        setSelectedSeat(seatNum);
        setBookingRef(data.booking_ref);
        setStep('otp');
      } else {
        setErrorMessage(data.error || "Failed to hold seat.");
      }
    } catch (err) {
      setErrorMessage("Network error holding seat.");
    } finally {
      setLoading(false);
    }
  };

  // 5. VERIFY OTP & PAY
  const handlePayment = async () => {
    if (!otp) {
      setErrorMessage("Please enter the OTP (e.g. 1234).");
      return;
    }
    setErrorMessage("");
    setLoading(true);
    try {
      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          booking_ref: bookingRef, 
          otp_code: otp, 
          amount: 500, 
          currency: 'BDT',
          callback_url: `${window.location.origin}/api/callback` 
        })
      });
      const data = await res.json();

      if (res.ok) {
        setStep('processing');
      } else {
        setErrorMessage(data.error || "Payment failed. Please try again.");
      }
    } catch (err) {
      setErrorMessage("Network error processing payment.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white p-6 max-w-xl mx-auto space-y-6 font-sans">
      <Button variant="ghost" onClick={() => router.push("/")} className="text-zinc-400 hover:text-white">
        ← Exit
      </Button>

      {/* Screen Component */}
      <div className="text-center space-y-2">
        <div className="w-full h-1 bg-blue-500 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.8)]" />
        <p className="text-[10px] uppercase tracking-[0.4em] text-zinc-500">SCREEN THIS WAY</p>
      </div>

      {/* Error Message Banner */}
      {errorMessage && (
        <div className="bg-red-950/80 border border-red-800 text-red-200 p-3 rounded-lg text-sm text-center">
          {errorMessage}
        </div>
      )}

      {/* STEP 1: SEAT MAP */}
      {step === 'map' && (
        <div className="space-y-6">
          <div className="bg-zinc-900 p-4 rounded-lg space-y-2">
             <label className="text-xs text-zinc-400 font-semibold">1. Phone Number (Required for OTP)</label>
             <input 
                value={phone} 
                onChange={e => setPhone(e.target.value)}
                className="w-full bg-black border border-zinc-800 p-3 rounded text-white focus:border-blue-500 outline-none"
                placeholder="e.g. 01700000000"
             />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-zinc-400 font-semibold">2. Select an Available Seat</label>
            <div className="grid grid-cols-5 gap-3">
              {seats.map((seat) => (
                <Button
                  key={seat.id}
                  disabled={seat.status !== 'AVAILABLE' || loading}
                  variant="outline"
                  className={`h-12 border-zinc-800 font-bold ${
                      seat.status === 'HELD' ? 'bg-yellow-600/20 text-yellow-500 border-yellow-600/50 cursor-not-allowed' : 
                      seat.status === 'BOOKED' ? 'bg-red-600/20 text-red-500 border-red-600/50 cursor-not-allowed' : 
                      'bg-zinc-900 text-white hover:bg-blue-600 hover:border-blue-500'
                  }`}
                  onClick={() => handleHold(seat.seat_number)}
                >
                  {seat.seat_number}
                </Button>
              ))}
            </div>
          </div>

          {/* Seat Status Legend */}
          <div className="flex justify-center gap-6 text-xs text-zinc-400 pt-2">
            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-zinc-800 border border-zinc-700 rounded-sm" /> Available</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-yellow-600/50 rounded-sm" /> Held</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-red-600/50 rounded-sm" /> Booked</div>
          </div>
        </div>
      )}

      {/* STEP 2: OTP VERIFICATION & COUNTDOWN */}
      {step === 'otp' && (
        <div className="bg-zinc-900 p-6 rounded-xl border border-zinc-800 space-y-6">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-xl font-bold">Verify OTP</h2>
              <p className="text-sm text-zinc-400">Seat <span className="text-blue-400 font-bold">{selectedSeat}</span> held for {phone}</p>
            </div>
            {/* Visual Countdown Timer */}
            <div className="text-right">
              <span className={`text-xl font-mono font-bold ${timeLeft < 15 ? 'text-red-500 animate-pulse' : 'text-yellow-500'}`}>
                {timeLeft}s
              </span>
              <p className="text-[10px] text-zinc-500">Hold Expires</p>
            </div>
          </div>

          <input 
            value={otp} 
            onChange={e => setOtp(e.target.value)}
            className="w-full bg-black border border-zinc-700 p-4 rounded-lg text-2xl tracking-[0.5em] text-center font-mono outline-none focus:border-blue-500"
            placeholder="1234"
            maxLength={6}
          />

          <div className="space-y-3">
            <Button onClick={handlePayment} disabled={loading} className="w-full h-14 bg-green-600 hover:bg-green-700 font-bold text-lg">
              {loading ? "Verifying..." : "Pay 500 BDT"}
            </Button>
            
            {/* Instant Cancel Button */}
            <Button 
              variant="ghost" 
              onClick={() => handleCancel()} 
              className="w-full text-zinc-500 hover:text-white"
            >
              Cancel & Pick Different Seat
            </Button>
          </div>
        </div>
      )}

      {/* STEP 3: ASYNC PROCESSING */}
      {step === 'processing' && (
        <div className="text-center py-16 space-y-4 bg-zinc-900/50 rounded-xl border border-zinc-800">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <h2 className="text-xl font-bold">Processing Payment...</h2>
          <p className="text-sm text-zinc-400 max-w-xs mx-auto">
            Awaiting confirmation from payment gateway. Do not refresh this page.
          </p>
        </div>
      )}

      {/* STEP 4: BOOKING CONFIRMED */}
      {step === 'success' && (
        <div className="text-center py-16 space-y-6 bg-zinc-900/80 border border-green-800/50 rounded-xl">
          <div className="text-6xl">🎉</div>
          <div className="space-y-2">
            <h2 className="text-3xl font-bold text-green-400">Booking Confirmed!</h2>
            <p className="text-zinc-300">Seat <span className="font-bold text-white">{selectedSeat}</span> is officially yours.</p>
          </div>
          <Button onClick={() => router.push('/')} className="bg-blue-600 hover:bg-blue-700 px-8">
            Back to Movies
          </Button>
        </div>
      )}
    </div>
  );
}