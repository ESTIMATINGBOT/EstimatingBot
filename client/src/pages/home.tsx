import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Upload, FileText, Phone, Mail, User, Building2,
  CheckCircle2, ArrowRight, Clock, Truck, Award, Link
} from "lucide-react";

export default function HomePage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    projectName: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [planUrl, setPlanUrl] = useState("");
  const [inputMode, setInputMode] = useState<"upload" | "link">("upload");
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Reset form and clear any cached bid status queries when landing on home page.
  // This ensures "Submit Another Plan" always starts completely fresh.
  useEffect(() => {
    setForm({ customerName: "", customerEmail: "", customerPhone: "", projectName: "" });
    setFile(null);
    setPlanUrl("");
    setInputMode("upload");
    setErrors({});
    // Wipe all cached bid status data so the new thank-you page polls fresh
    queryClient.removeQueries({ queryKey: ["/api/bids"] });
    // Reset the file input element if it exists
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []); // runs once on mount — every navigation to "/" creates a fresh component instance

  // File handling
  const handleFile = (f: File) => {
    if (f.type !== "application/pdf") {
      toast({ title: "PDF only", description: "Please upload a PDF plan file.", variant: "destructive" });
      return;
    }
    if (f.size > 200 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum file size is 200 MB.", variant: "destructive" });
      return;
    }
    setFile(f);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, []);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);

  // Validation
  const validate = () => {
    const errs: Record<string, string> = {};
    if (!form.customerName.trim()) errs.customerName = "Name is required";
    if (!form.customerEmail.trim()) errs.customerEmail = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.customerEmail)) errs.customerEmail = "Valid email required";
    if (!form.customerPhone.trim()) errs.customerPhone = "Phone is required";
    if (inputMode === "upload" && !file) errs.file = "Please upload your plan PDF";
    if (inputMode === "link" && !planUrl.trim()) errs.file = "Please paste a Google Drive or Dropbox link";
    if (inputMode === "link" && planUrl.trim() && !/^https?:\/\//i.test(planUrl)) errs.file = "Please enter a valid URL starting with https://";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // Submit
  const submitMutation = useMutation({
    mutationFn: async () => {
      const data = new FormData();
      data.append("customerName", form.customerName);
      data.append("customerEmail", form.customerEmail);
      data.append("customerPhone", form.customerPhone);
      data.append("projectName", form.projectName);

      if (inputMode === "link") {
        data.append("planUrl", planUrl.trim());
      } else {
        data.append("planFile", file!);
      }

      const base = "__PORT_5000__".startsWith("__") ? "https://estimatingbot-production.up.railway.app" : "__PORT_5000__";
      const res = await fetch(`${base}/api/bids`, { method: "POST", body: data });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Submission failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      navigate(`/thank-you/${data.bidId}`);
    },
    onError: (err: Error) => {
      toast({ title: "Submission failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validate()) submitMutation.mutate();
  };

  const change = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, [field]: e.target.value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: "" }));
  };

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
              className="text-sm hover:text-[#C8D400] transition-colors">
              rebarconcreteproducts.com
            </a>
          </div>
        </div>
        {/* Lime stripe */}
        <div className="h-[3px] bg-[#C8D400]" />
      </header>

      {/* Hero */}
      <section className="bg-black text-white py-12 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-[#C8D400] text-black text-xs font-bold px-3 py-1 rounded-full mb-6 uppercase tracking-wider">
            <FileText className="w-3.5 h-3.5" />
            Free Preliminary Estimate
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold mb-4 leading-tight" style={{ fontFamily: "'Cabinet Grotesk', sans-serif" }}>
            Upload Your Plans.<br />Get a Rebar Estimate.
          </h1>
          <p className="text-gray-300 text-base max-w-xl mx-auto leading-relaxed">
            Upload your structural or concrete plans as a PDF and we'll generate a branded preliminary rebar estimate and send it directly to your email — typically within minutes.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section className="bg-[#0a0a0a] border-y border-[#1a1a1a] py-8 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { icon: Upload, step: "1", label: "Upload PDF", desc: "Your structural plans" },
              { icon: FileText, step: "2", label: "AI Takeoff", desc: "Automated rebar extraction" },
              { icon: Mail, step: "3", label: "Get Estimate", desc: "Delivered to your inbox" },
            ].map(({ icon: Icon, step, label, desc }) => (
              <div key={step} className="flex flex-col items-center gap-2">
                <div className="w-10 h-10 rounded-full bg-[#C8D400] flex items-center justify-center text-black font-bold text-sm">
                  {step}
                </div>
                <div className="text-white font-semibold text-sm">{label}</div>
                <div className="text-gray-500 text-xs">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Main form */}
      <main className="flex-1 py-12 px-4">
        <div className="max-w-2xl mx-auto">
          <Card className="border-border shadow-lg">
            <CardContent className="p-6 sm:p-8">
              <h2 className="text-xl font-bold mb-1" style={{ fontFamily: "'Cabinet Grotesk', sans-serif" }}>
                Request Your Estimate
              </h2>
              <p className="text-muted-foreground text-sm mb-6">
                Enter your contact info and upload your plan PDF. We'll send a preliminary estimate to your email address.
              </p>

              <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                {/* Name */}
                <div className="space-y-1.5">
                  <Label htmlFor="customerName" className="flex items-center gap-1.5 text-sm font-medium">
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                    Full Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="customerName"
                    data-testid="input-name"
                    type="text"
                    placeholder="John Smith"
                    value={form.customerName}
                    onChange={change("customerName")}
                    className={errors.customerName ? "border-destructive" : ""}
                  />
                  {errors.customerName && (
                    <p className="text-destructive text-xs">{errors.customerName}</p>
                  )}
                </div>

                {/* Email */}
                <div className="space-y-1.5">
                  <Label htmlFor="customerEmail" className="flex items-center gap-1.5 text-sm font-medium">
                    <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                    Email Address <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="customerEmail"
                    data-testid="input-email"
                    type="email"
                    placeholder="you@example.com"
                    value={form.customerEmail}
                    onChange={change("customerEmail")}
                    className={errors.customerEmail ? "border-destructive" : ""}
                  />
                  {errors.customerEmail && (
                    <p className="text-destructive text-xs">{errors.customerEmail}</p>
                  )}
                </div>

                {/* Phone */}
                <div className="space-y-1.5">
                  <Label htmlFor="customerPhone" className="flex items-center gap-1.5 text-sm font-medium">
                    <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                    Phone Number <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="customerPhone"
                    data-testid="input-phone"
                    type="tel"
                    placeholder="(555) 555-5555"
                    value={form.customerPhone}
                    onChange={change("customerPhone")}
                    className={errors.customerPhone ? "border-destructive" : ""}
                  />
                  {errors.customerPhone && (
                    <p className="text-destructive text-xs">{errors.customerPhone}</p>
                  )}
                </div>

                {/* Project name (optional) */}
                <div className="space-y-1.5">
                  <Label htmlFor="projectName" className="flex items-center gap-1.5 text-sm font-medium">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                    Project Name <span className="text-muted-foreground text-xs font-normal">(optional)</span>
                  </Label>
                  <Input
                    id="projectName"
                    data-testid="input-project-name"
                    type="text"
                    placeholder="e.g. 123 Oak Street Residence"
                    value={form.projectName}
                    onChange={change("projectName")}
                  />
                </div>

                {/* Plan input — toggle between upload and link */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5 text-sm font-medium">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                    Plan <span className="text-destructive">*</span>
                  </Label>

                  {/* Mode toggle */}
                  <div className="flex rounded-lg border border-border overflow-hidden text-sm font-medium">
                    <button
                      type="button"
                      data-testid="tab-upload"
                      onClick={() => { setInputMode("upload"); setErrors(prev => ({ ...prev, file: "" })); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 transition-colors ${
                        inputMode === "upload"
                          ? "bg-black text-white"
                          : "bg-muted/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Upload className="w-3.5 h-3.5" /> Upload PDF
                    </button>
                    <button
                      type="button"
                      data-testid="tab-link"
                      onClick={() => { setInputMode("link"); setErrors(prev => ({ ...prev, file: "" })); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 transition-colors ${
                        inputMode === "link"
                          ? "bg-black text-white"
                          : "bg-muted/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Link className="w-3.5 h-3.5" /> Paste Link
                    </button>
                  </div>

                  {/* Upload mode */}
                  {inputMode === "upload" && (
                    <div
                      data-testid="drop-zone"
                      className={`drop-zone cursor-pointer p-6 text-center ${dragOver ? "drag-over" : ""} ${errors.file ? "border-destructive" : ""}`}
                      onDrop={onDrop}
                      onDragOver={onDragOver}
                      onDragLeave={onDragLeave}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/pdf"
                        className="hidden"
                        data-testid="input-file"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) { handleFile(f); setErrors(prev => ({ ...prev, file: "" })); }
                        }}
                      />
                      {file ? (
                        <div className="flex items-center justify-center gap-3">
                          <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
                          <div className="text-left">
                            <p className="font-medium text-sm truncate max-w-xs">{file.name}</p>
                            <p className="text-muted-foreground text-xs">
                              {(file.size / 1024 / 1024).toFixed(2)} MB — click to change
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <Upload className="w-8 h-8 text-muted-foreground" />
                          <p className="font-medium text-sm">Drop PDF here or click to browse</p>
                          <p className="text-muted-foreground text-xs">PDF up to 200 MB</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Link mode */}
                  {inputMode === "link" && (
                    <div className="space-y-2">
                      <Input
                        data-testid="input-plan-url"
                        type="url"
                        placeholder="https://drive.google.com/file/d/... or https://dropbox.com/s/..."
                        value={planUrl}
                        onChange={(e) => { setPlanUrl(e.target.value); setErrors(prev => ({ ...prev, file: "" })); }}
                        className={errors.file ? "border-destructive" : ""}
                      />
                      <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
                        <p className="font-medium text-foreground">Sharing tips:</p>
                        <p><span className="font-medium">Google Drive:</span> Set to "Anyone with the link can view"</p>
                        <p><span className="font-medium">Dropbox:</span> Change <code>?dl=0</code> to <code>?dl=1</code> at the end of the URL</p>
                      </div>
                    </div>
                  )}

                  {errors.file && (
                    <p className="text-destructive text-xs">{errors.file}</p>
                  )}
                </div>

                {/* Disclaimer */}
                <div className="rounded-lg border-2 border-yellow-400 bg-yellow-50 p-4 space-y-1">
                  <p className="text-xs font-extrabold text-yellow-800 uppercase tracking-wide">
                    ⚠ Preliminary Estimate — Not For Construction
                  </p>
                  <p className="text-xs text-yellow-800 leading-relaxed">
                    This estimate contains <strong>approximate quantities for bidding and budgeting purposes only.</strong> It is <strong>not</strong> a certified material list and is <strong>not suitable for ordering material or use in construction.</strong> Final quantities are subject to a full engineering takeoff upon contract award. Prices are subject to change without notice. Tax rate: 8.25% (McKinney, TX).
                  </p>
                </div>

                {/* Submit */}
                <Button
                  type="submit"
                  data-testid="button-submit"
                  disabled={submitMutation.isPending}
                  className="w-full h-12 text-sm font-bold bg-[#C8D400] hover:bg-[#b5bf00] text-black"
                >
                  {submitMutation.isPending ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      Submitting...
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      Request My Estimate
                      <ArrowRight className="w-4 h-4" />
                    </span>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Trust signals */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
            {[
              { icon: Clock, label: "Fast Turnaround", desc: "Estimates typically within minutes" },
              { icon: Award, label: "Est. 2022", desc: "Rebar specialists in McKinney, TX" },
              { icon: Truck, label: "Material Only", desc: "We supply the steel — you place it" },
            ].map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex flex-col items-center gap-1.5 p-4 rounded-xl bg-muted/40">
                <Icon className="w-5 h-5 text-[#5a6200]" />
                <p className="font-semibold text-sm">{label}</p>
                <p className="text-muted-foreground text-xs">{desc}</p>
              </div>
            ))}
          </div>
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
