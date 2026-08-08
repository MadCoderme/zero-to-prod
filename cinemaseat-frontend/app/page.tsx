"use client";
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  const [movies, setMovies] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/movies')
      .then(res => res.json())
      .then(data => setMovies(data.movies || []))
      .catch(err => console.error("Failed to load movies", err));
  }, []);

  return (
    <div className="max-w-2xl mx-auto p-10 space-y-8 font-sans">
      <h1 className="text-4xl font-black tracking-tighter text-blue-600">CinemaSeat</h1>
      <div className="grid gap-4">
        {movies.map((movie) => (
          <Card key={movie.id} className="bg-zinc-900 border-zinc-800 hover:border-blue-500 transition-all">
            <CardContent className="p-6 flex justify-between items-center text-white">
              <div>
                <CardTitle className="text-xl font-bold">{movie.title}</CardTitle>
                <p className="text-zinc-500 text-sm">{movie.theater || 'Main Hall'}</p>
              </div>
              <Link href={`/seats/${movie.id}`}>
                <Button className="bg-blue-600 hover:bg-blue-700 font-bold px-6">
                  Select
                </Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}