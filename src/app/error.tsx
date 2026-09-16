"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) { return <div className="empty-state"><h1>Workspace unavailable.</h1><p style={{margin:"20px 0"}}>Your data could not be loaded. Check the connection and database setup, then try again.</p><Button onClick={reset}>Try again</Button></div>; }
