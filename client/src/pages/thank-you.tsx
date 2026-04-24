import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, AlertCircle, Mail, Phone, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

type StatusData = {
  status: "pending" | "processing" | "complete" | "failed";
  message: string | null;
};

export default function ThankYouPage() {
  const { bidId } = useParams<{ bidId: string }>();
  const [, navigate] = useLocation();

  const statusQuery = useQuery<StatusData>({
    queryKey: ["/api/bids", bidId, "status"],
    queryFn: undefined,
    refetchInterval: (query) => {
      const data = query.state.data as StatusData | undefined;
      if (!data) return 3000;
      if (data.status === "complete" || data.status === "failed") return false;
      return 3000;
    },
    enabled: !!bidId,
  });

  const status = statusQuery.data?.status;
  const message = statusQuery.data?.message;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="bg-black text-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between py-0">
          <div className="h-[64px] flex items-center">
            <div className="flex items-baseline gap-1">
              <span className="text-[#C8D400] font-extrabold text-2xl tracking-tight" style={{ fontFamily: "'Cabinet Grotesk', sans-serif" }}>REBAR</span>
              <span className="text-white font-semibold text-lg tracking-wide" style={{ fontFamily: "'Cabinet Grotesk', sans-serif" }}> CONCRETE PRODUCTS</span>
            </div>
          </div>
          <div className="hidden sm:flex flex-col items-end text-right leading-7 text-gray-300">
            <span className="text-sm font-semibold text-white">2112 N Custer Rd — McKinney, TX 75071</span>
            <a href="tel:4696317730" className="text-[#C8D400] font-extrabold text-xl tracking-wide hover:text-white transition-colors">469-631-7730</a>
            <a href="https://rebarconcreteproducts.com" target="_blank" rel="noopener noreferrer"
              className="text-sm hover:text-[#C8D400] transition-colors">rebarconcreteproducts.com</a>
          </div>
        </div>
        <div className="h-[3px] bg-[#C8D400]" />
      </header>

      {/* Status content */}
      <main className="flex-1 flex items-center justify-center py-16 px-4">
        <div className="max-w-lg w-full text-center space-y-6">

          {/* Icon */}
          <div className="flex justify-center">
            {status === "complete" ? (
              <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-green-600" />
              </div>
            ) : status === "failed" ? (
              <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center">
                <AlertCircle className="w-10 h-10 text-red-600" />
              </div>
            ) : (
              <div className="w-20 h-20 rounded-full bg-[#C8D400]/20 flex items-center justify-center">
                <span className="w-10 h-10 border-4 border-[#C8D400] border-t-transparent rounded-full animate-spin block" />
              </div>
            )}
          </div>

          {/* Heading */}
          <div>
            {status === "complete" ? (
              <>
                <h1 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Cabinet Grotesk', sans-serif" }}>
                  Your estimate is on its way!
                </h1>
                <p className="text-muted-foreground">
                  {message || "Check your inbox — your preliminary rebar estimate has been sent."}
                </p>
              </>
            ) : status === "failed" ? (
              <>
                <h1 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Cabinet Grotesk', sans-serif" }}>
                  Something went wrong
                </h1>
                <p className="text-muted-foreground">
                  {message || "Our team has been notified and will follow up with you manually."}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Cabinet Grotesk', sans-serif" }}>
                  Processing your plans...
                </h1>
                <p className="text-muted-foreground">
                  {message || "Our AI is reading your plans and building your estimate. This typically takes 5–15 minutes depending on plan size."}
                </p>
              </>
            )}
          </div>

          {/* Progress / next steps */}
          {(status === "pending" || status === "processing") && (
            <div className="bg-muted/50 rounded-xl p-5 text-left space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="w-5 h-5 border-2 border-[#C8D400] border-t-transparent rounded-full animate-spin shrink-0" />
                <span className="font-medium">Running AI rebar takeoff...</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="w-4 h-4 shrink-0" />
                <span>Typically 5–15 minutes depending on plan size</span>
              </div>
              <p className="text-xs text-muted-foreground">
                You can safely close this page — we'll email your estimate directly when it's ready.
              </p>
            </div>
          )}

          {status === "complete" && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-5 text-left space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-green-700">
                <Mail className="w-4 h-4 shrink-0" />
                Your estimate has been sent to your inbox
              </div>
              {message && (
                <p className="text-base font-semibold text-green-800">{message}</p>
              )}
              <p className="text-xs text-green-700">
                Check your inbox (and spam folder just in case). A copy has also been sent to our team.
              </p>
              <p className="text-xs text-green-600">
                Ready to place an order or have questions? Call or email us below — we're here Mon–Fri, 6 AM–3 PM CST.
              </p>
            </div>
          )}

          {status === "failed" && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-5 text-left space-y-2">
              <p className="text-xs text-red-700">
                Our team has been notified. Please contact us directly and we'll prepare your estimate manually.
              </p>
            </div>
          )}

          {/* Contact block (always visible) */}
          <div className="border border-border rounded-xl p-5 text-left space-y-3">
            <p className="font-semibold text-sm">Questions? Contact us directly:</p>
            <div className="space-y-2">
              <a href="tel:4696317730" className="flex items-center gap-2 text-sm hover:text-[#5a6200] transition-colors">
                <Phone className="w-4 h-4 text-muted-foreground" />
                469-631-7730
              </a>
              <a href="mailto:Office@RebarConcreteProducts.com"
                className="flex items-center gap-2 text-sm hover:text-[#5a6200] transition-colors">
                <Mail className="w-4 h-4 text-muted-foreground" />
                Office@RebarConcreteProducts.com
              </a>
              <p className="text-xs text-muted-foreground pl-6">Monday–Friday, 6:00 AM – 3:00 PM CST</p>
            </div>
          </div>

          {/* Back button */}
          <Button
            variant="outline"
            data-testid="button-back"
            onClick={() => navigate("/")}
            className="w-full gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Submit Another Plan
          </Button>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-black text-gray-400 py-6 px-4">
        <div className="h-[3px] bg-[#C8D400] mb-6" />
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[#C8D400] font-bold text-sm">REBAR</span>
            <span className="text-gray-400 font-medium text-xs">CONCRETE PRODUCTS</span>
            <span className="text-gray-600 text-xs ml-1">— 2112 N Custer Rd, McKinney, TX 75071</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 items-center">
            <a href="tel:4696317730" className="hover:text-[#C8D400] transition-colors">469-631-7730</a>
            <a href="mailto:Office@RebarConcreteProducts.com" className="hover:text-[#C8D400] transition-colors">
              Office@RebarConcreteProducts.com
            </a>
            <span className="text-gray-600">Mon–Fri 6am–3pm CST</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
