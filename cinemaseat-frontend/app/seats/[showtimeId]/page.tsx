"use client";
import { useParams, useRouter } from "next/navigation";
import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast"; // or your toast import

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

  // 1. POLL SEAT MAP (Every 2 seconds)
  useEffect(() => {
    const fetchSeats = () => {
      fetch(`/api/shows/${showtimeId}/seats`)
        .then(res => res.json())
        .then(data => {
          setSeats(data.seats);
          // If our selected seat just became BOOKED while we were processing, show success
          const mySeat = data.seats.find((s: any) => s.seat_number === selectedSeat);
          if (mySeat?.status === 'BOOKED' && step === 'processing') setStep('success');
        });
    };

    fetchSeats();
    const interval = setInterval(fetchSeats, 2000);
    return () => clearInterval(interval);
  }, [showtimeId, selectedSeat, step]);

  // 2. HOLD SEAT & SEND OTP
  const handleHold = async (seatNum: string) => {
    if (!phone) {
      toast.add({ type: "destructive", title: "Phone required", description: "Enter phone to receive OTP" });
      return;
    }
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
        toast.add({ title: "OTP Sent!", description: "Check your phone for the code." });
      } else {
        toast.add({ type: "destructive", title: "Oversell Protection", description: data.error });
      }
    } finally {
      setLoading(false);
    }
  };

  // 3. VERIFY OTP & PAY
  const handlePayment = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          booking_ref: bookingRef, 
          otp_code: otp, 
          amount: 450, 
          currency: 'BDT',
          callback_url: `${window.location.origin}/api/callback` 
        })
      });
      const data = await res.json();

      if (res.ok) {
        setStep('processing');
        toast.add({ title: "Payment Initiated", description: "Waiting for gateway confirmation..." });
      } else {
        toast.add({ type: "destructive", title: "Payment Error", description: data.error });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white p-6 max-w-xl mx-auto space-y-8">
      <Button variant="ghost" onClick={() => router.push("/")} className="text-zinc-400 hover:text-white">
        ← Exit
      </Button>

      {/* Screen Component */}
      <div className="text-center space-y-4">
        <div className="w-full h-1 bg-blue-500 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.8)]" />
        <p className="text-[10px] uppercase tracking-[0.4em] text-zinc-500">Screen</p>
      </div>

      {step === 'map' && (
        <div className="space-y-6">
          <div className="grid grid-cols-5 gap-3">
            {seats.map((seat) => (
              <Button
                key={seat.id}
                disabled={seat.status !== 'AVAILABLE' || loading}
                variant="outline"
                className={`h-12 border-zinc-800 ${
                    seat.status === 'HELD' ? 'bg-yellow-600/20 text-yellow-500 border-yellow-600/50' : 
                    seat.status === 'BOOKED' ? 'bg-red-600/20 text-red-500 border-red-600/50' : ''
                }`}
                onClick={() => handleHold(seat.seat_number)}
              >
                {seat.seat_number}
              </Button>
            ))}
          </div>
          <div className="bg-zinc-900 p-4 rounded-lg space-y-3">
             <label className="text-xs text-zinc-400">Your Phone Number (Required for OTP)</label>
             <input 
                value={phone} 
                onChange={e => setPhone(e.target.value)}
                className="w-full bg-black border border-zinc-800 p-3 rounded"
                placeholder="017xxxxxxxx"
             />
          </div>
        </div>
      )}

      {step === 'otp' && (
        <div className="bg-zinc-900 p-6 rounded-xl border border-zinc-800 space-y-6">
          <div className="space-y-2">
            <h2 className="text-xl font-bold">Verify OTP</h2>
            <p className="text-sm text-zinc-500">Confirming Seat {selectedSeat} for {phone}</p>
          </div>
          <input 
            value={otp} 
            onChange={e => setOtp(e.target.value)}
            className="w-full bg-black border border-zinc-700 p-4 rounded-lg text-2xl tracking-[0.5em] text-center"
            placeholder="0000"
          />
          <Button onClick={handlePayment} disabled={loading} className="w-full h-14 bg-green-600 hover:bg-green-700 font-bold">
            {loading ? "Confirming..." : "Pay 450 BDT"}
          </Button>
        </div>
      )}

      {step === 'processing' && (
        <div className="text-center py-20 space-y-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <h2 className="text-xl font-bold">Processing Booking...</h2>
          <p className="text-zinc-500">Waiting for Gateway callback. Don't refresh.</p>
        </div>
      )}

      {step === 'success' && (
        <div className="text-center py-20 space-y-6 animate-in zoom-in duration-300">
          <div className="text-6xl">🎉</div>
          <h2 className="text-3xl font-bold">Booking Confirmed!</h2>
          <p className="text-zinc-400">Seat {selectedSeat} is yours.</p>
          <Button onClick={() => router.push('/')} className="w-full bg-blue-600">Back to Movies</Button>
        </div>
      )}
    </div>
  );
}