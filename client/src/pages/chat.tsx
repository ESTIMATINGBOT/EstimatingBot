import { useState, useRef, useEffect } from "react";
import { Send, MessageSquare, CheckCircle2, ExternalLink, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Message {
  role: "user" | "assistant";
  content: string;
  imageUrl?: string; // data URL for display only
}

interface OrderData {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerCompany?: string;
  deliveryAddress?: string;
  deliveryNotes?: string;
  items?: { name: string; qboItemId: string; qty: number; unitPrice: number; description?: string }[];
  subtotal?: number;
  tax?: number;
  total?: number;
  readyToInvoice?: boolean;
}

interface InvoiceResult {
  invoiceNumber: string;
  paymentLink: string;
  total: number;
}



const WELCOME: Message = {
  role: "assistant",
  content:
    "Hi! I'm the RCP Assistant. I can help you with rebar questions, material quantities, and placing orders with a QuickBooks invoice.\n\nFor plan uploads and automated AI estimates, use the **Estimate** tab above.\n\nHow can I help you today?",
};

function renderContent(text: string) {
  const html = text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br/>");
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceResult | null>(null);
  const [pendingOrder, setPendingOrder] = useState<OrderData | null>(null);
  const [pendingImage, setPendingImage] = useState<{ base64: string; mediaType: string; dataUrl: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgsContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Only auto-scroll after the first message — don't hijack page scroll on mount
    if (messages.length > 1 || loading || invoice) {
      // Scroll within the messages container only — avoid scrolling parent page
      if (msgsContainerRef.current) {
        msgsContainerRef.current.scrollTop = msgsContainerRef.current.scrollHeight;
      }
    }
  }, [messages, loading, invoice]);

  // Ref so the postMessage handler can call send() without stale closure
  const sendRef = useRef<((text?: string) => Promise<void>) | null>(null);
  useEffect(() => { sendRef.current = send; });

  // Listen for prompt injected via postMessage from parent Shopify page (chip clicks)
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data && e.data.type === 'rcp-prompt' && typeof e.data.text === 'string' && e.data.text.trim()) {
        const text = e.data.text.trim();
        if (sendRef.current) {
          sendRef.current(text);
        } else {
          setInput(text);
        }
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const addMessage = (msg: Message) => setMessages(prev => [...prev, msg]);

  const createInvoice = async (order: OrderData) => {
    setInvoicing(true);
    try {
      // Extract cached delivery distance/fee from the SYSTEM note in history (if present)
      // This acts as a fallback if the server-side Maps lookup fails
      let cachedMiles: number | undefined;
      let cachedFee: number | undefined;
      const sysNote = messages.find(m => m.content.startsWith("SYSTEM: Google Maps distance"));
      if (sysNote) {
        const milesMatch = sysNote.content.match(/([\d.]+) miles/);
        const feeMatch = sysNote.content.match(/fee: \$([\d.]+)/);
        if (milesMatch) cachedMiles = parseFloat(milesMatch[1]);
        if (feeMatch) cachedFee = parseFloat(feeMatch[1]);
      }

      let res: Response;
      try {
        res = await fetchWithTimeout("/api/web-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: order.customerName,
            customerEmail: order.customerEmail,
            customerPhone: order.customerPhone || "",
            customerCompany: order.customerCompany || "",
            deliveryAddress: order.deliveryAddress || "",
            deliveryNotes: order.deliveryNotes || "",
            deliveryMilesFallback: cachedMiles,
            deliveryFeeFallback: cachedFee,
            items: order.items,
          }),
        }, 25000);
      } catch (err: any) {
        const code = err?.message === "TIMEOUT" ? "ERR-INV-TIMEOUT" : "ERR-INV-NETWORK";
        addMessage({ role: "assistant", content: `We weren't able to reach our invoicing system. Please call us at **469-631-7730** and we'll get it sorted out. (${code})` });
        return;
      }
      const data = await res.json();
      // Customer not on file — fraud prevention
      if (res.status === 403 && data.error === "customer_not_found") {
        addMessage({
          role: "assistant",
          content: `We weren’t able to verify an account for **${order.customerName}** with that phone number. To place orders online you’ll need an account on file with us.\n\nGive us a call at **469-631-7730** or stop by **2112 N Custer Rd, McKinney, TX 75071** and we’ll get you set up — it only takes a minute.`,
        });
        return;
      }
      if (!res.ok || !data.success) {
        const serverCode = data.error ? `ERR-INV-${res.status}` : `ERR-INV-${res.status}`;
        throw new Error(`${data.error || "Invoice creation failed"} (${serverCode})`);
      }
      const invoiceTotal = typeof data.total === "number" ? data.total : parseFloat(data.total) || 0;
      setInvoice({ invoiceNumber: data.invoiceNumber, paymentLink: data.paymentLink, total: invoiceTotal });
      addMessage({
        role: "assistant",
        content: `Invoice #${data.invoiceNumber} has been created for **$${invoiceTotal.toFixed(2)}** (includes 8.25% tax).${order.customerEmail ? ` A copy has been emailed to ${order.customerEmail}.` : ""} You can also pay using the link below.`,
      });
      return; // success — skip catch
    } catch (err: any) {
      console.error("[invoice error]", err?.message, err);
      const errCode = err?.message || "ERR-INV-UNKNOWN";
      addMessage({
        role: "assistant",
        content: `There was an issue creating your invoice — please call us at **469-631-7730** and we'll take care of it right away. (${errCode})`,
      });
    } finally {
      setInvoicing(false);
      setPendingOrder(null);
    }
  };

  // Extract a delivery address from any text.
  // Strategy 1: grab everything up to and including a 5-digit zip code.
  // Strategy 2: grab street number + road keyword + city + 2-letter state (no zip).
  const extractAddress = (text: string): string | null => {
    // Strategy 1: text contains a zip code — extract up to the zip
    const zipMatch = text.match(/(\d+\s+[\w][\w\s.,#-]{3,}?\b[a-zA-Z]{2}\s*\d{5})/);
    if (zipMatch) return zipMatch[1].trim();
    // Strategy 2: street number + road type keyword + anything + 2-letter state
    const roadMatch = text.match(/(\d+\s+[\w\s.,#-]+(blvd|ave|rd|st|dr|ln|way|fwy|hwy|pkwy|ct|cir|pl|street|avenue|road|drive|lane|highway|freeway)[\w\s.,#-]+\b[a-zA-Z]{2}\b)/i);
    if (roadMatch) return roadMatch[1].trim();
    return null;
  };

  // Look up real Google Maps distance for an address
  const lookupDelivery = async (address: string): Promise<{ miles: number; fee: number; freeThreshold: number | null } | null> => {
    try {
      const r = await fetchWithTimeout(`/api/calc-delivery?address=${encodeURIComponent(address)}`, {}, 10000);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; } // silent — delivery fee just won't be pre-filled
  };

  // Fetch with timeout — rejects with a typed error if the request takes too long
  const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err: any) {
      if (err?.name === "AbortError") throw new Error("TIMEOUT");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so same file can be reselected
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      // Extract base64 and media type from data URL
      const [meta, base64] = dataUrl.split(",");
      const mediaType = meta.match(/:(.*?);/)?.[1] || "image/jpeg";
      setPendingImage({ base64, mediaType, dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text && !pendingImage || loading) return;

    const userMsg: Message = { role: "user", content: text || "[image]", imageUrl: pendingImage?.dataUrl };
    const imageToSend = pendingImage;
    setPendingImage(null);
    let newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setLoading(true);

    let handledByInvoice = false;

    try {
      // Check if a SYSTEM distance note has already been injected in this conversation
      const alreadyInjected = newHistory.some(m => m.content.startsWith("SYSTEM: Google Maps distance"));

      if (!alreadyInjected) {
        // Scan all user messages (newest first) for a delivery address
        const allUserText = newHistory
          .filter(m => m.role === "user")
          .map(m => m.content)
          .reverse();
        let foundAddress: string | null = null;
        for (const msg of allUserText) {
          foundAddress = extractAddress(msg);
          if (foundAddress) break;
        }

        if (foundAddress) {
          const dist = await lookupDelivery(foundAddress);
          if (dist) {
            const feeNote = dist.freeThreshold
              ? `SYSTEM: Google Maps distance from RCP McKinney to customer delivery address: ${dist.miles} miles. Delivery fee: $${dist.fee.toFixed(2)} ($3/mile). Free delivery applies if order total reaches $${dist.freeThreshold.toLocaleString()}.`
              : `SYSTEM: Google Maps distance from RCP McKinney to customer delivery address: ${dist.miles} miles. Delivery fee: $${dist.fee.toFixed(2)} ($3/mile). This address is beyond 65 miles — delivery fee applies regardless of order size.`;
            newHistory = [...newHistory, { role: "user", content: feeNote }];
          }
        }
      }

      let res: Response;
      try {
        res = await fetchWithTimeout("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: newHistory.map(m => ({ role: m.role, content: m.content })),
            imageBase64: imageToSend?.base64 || null,
            imageMediaType: imageToSend?.mediaType || null,
          }),
        }, 30000);
      } catch (err: any) {
        const code = err?.message === "TIMEOUT" ? "ERR-CHAT-TIMEOUT" : "ERR-CHAT-NETWORK";
        addMessage({ role: "assistant", content: `Something went wrong connecting to the assistant. Please try again or call us at **469-631-7730**. (${code})` });
        return;
      }
      if (!res.ok) {
        addMessage({ role: "assistant", content: `The assistant returned an error. Please try again or call us at **469-631-7730**. (ERR-CHAT-${res.status})` });
        return;
      }
      const data = await res.json();
      const replyText: string = data.reply || "Sorry, something went wrong. Please call 469-631-7730.";

      // Check if AI embedded a structured order JSON block — auto-fire invoice immediately
      const orderMatch = replyText.match(/```order\n([\s\S]+?)\n```/);
      if (orderMatch) {
        try {
          const order: OrderData = JSON.parse(orderMatch[1]);
          if (order.readyToInvoice && order.customerName && order.customerPhone && order.items?.length) {
            // Show the reply without the JSON block first
            const cleanReply = replyText.replace(/```order\n[\s\S]+?\n```/, "").trim();
            addMessage({ role: "assistant", content: cleanReply });
            setLoading(false);
            handledByInvoice = true;
            // Auto-create invoice immediately — no extra confirm button needed
            await createInvoice(order);
            return;
          }
        } catch {}
      }

      addMessage({ role: "assistant", content: replyText });
    } catch (err: any) {
      const code = err?.message === "TIMEOUT" ? "ERR-SEND-TIMEOUT" : "ERR-SEND-UNKNOWN";
      addMessage({ role: "assistant", content: `Something went wrong. Please try again or call us at **469-631-7730**. (${code})` });
    } finally {
      if (!handledByInvoice) {
        setLoading(false);
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={msgsContainerRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="w-8 h-8 rounded-full bg-[#C8D400]/20 border border-[#C8D400]/40 flex items-center justify-center flex-shrink-0 mr-3 mt-0.5">
                <MessageSquare className="w-4 h-4 text-[#C8D400]" />
              </div>
            )}
            <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              msg.role === "user"
                ? "bg-[#C8D400] text-black rounded-tr-sm font-medium"
                : "bg-white/5 border border-white/10 text-gray-100 rounded-tl-sm"
            }`}>
              {msg.imageUrl && (
                <img
                  src={msg.imageUrl}
                  alt="uploaded"
                  className="rounded-lg max-w-full mb-2 max-h-48 object-contain"
                />
              )}
              {msg.content !== "[image]" && renderContent(msg.content)}
            </div>
          </div>
        ))}

        {/* Invoice result card */}
        {invoice && (
          <div className="flex justify-start">
            <div className="ml-11 bg-[#C8D400]/10 border border-[#C8D400]/30 rounded-xl p-4 space-y-3 max-w-xs">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-[#C8D400]" />
                <span className="text-white font-semibold text-sm">Invoice #{invoice.invoiceNumber}</span>
              </div>
              <p className="text-gray-300 text-sm">Total: <span className="text-white font-bold">${typeof invoice.total === "number" ? invoice.total.toFixed(2) : "—"}</span></p>
              {invoice.paymentLink ? (
                <a
                  href={invoice.paymentLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 bg-[#C8D400] text-black text-sm font-bold px-4 py-2 rounded-lg hover:bg-[#b0bb00] transition-colors w-full justify-center"
                >
                  <ExternalLink className="w-4 h-4" /> Pay Invoice
                </a>
              ) : (
                <p className="text-xs text-gray-400">Call us at 469-631-7730 to complete payment.</p>
              )}
            </div>
          </div>
        )}

        {(loading || invoicing) && (
          <div className="flex justify-start">
            <div className="w-8 h-8 rounded-full bg-[#C8D400]/20 border border-[#C8D400]/40 flex items-center justify-center flex-shrink-0 mr-3 mt-0.5">
              <MessageSquare className="w-4 h-4 text-[#C8D400]" />
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1 items-center h-4">
                <span className="w-1.5 h-1.5 rounded-full bg-[#C8D400] animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#C8D400] animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#C8D400] animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Quick prompts */}
      {messages.length === 1 && (
        <div className="px-4 pb-3 flex flex-wrap gap-2 justify-center">
          {[
            "I want to place an order",
            "How much rebar for a 20x20 slab?",
            "What sizes do you carry?",
            "How do I get an estimate?",
          ].map(prompt => (
            <button
              key={prompt}
              onClick={() => { setInput(prompt); setTimeout(() => textareaRef.current?.focus(), 50); }}
              className="text-xs px-3 py-1.5 rounded-full border border-white/20 text-gray-300 hover:border-[#C8D400]/50 hover:text-[#C8D400] transition-colors bg-white/5"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="px-4 pb-4 pt-2 border-t border-white/10">
        {/* Image preview */}
        {pendingImage && (
          <div className="relative inline-block mb-2">
            <img
              src={pendingImage.dataUrl}
              alt="preview"
              className="h-16 w-16 object-cover rounded-lg border border-[#C8D400]/40"
            />
            <button
              onClick={() => setPendingImage(null)}
              className="absolute -top-1.5 -right-1.5 bg-black border border-white/20 rounded-full p-0.5 hover:border-red-400"
            >
              <X className="w-3 h-3 text-white" />
            </button>
          </div>
        )}
        <div className="flex gap-2 items-end">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageSelect}
          />
          {/* Image upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={invoicing || loading}
            title="Attach a photo"
            className="h-[42px] w-[42px] flex items-center justify-center rounded-xl border border-white/20 bg-white/5 text-gray-400 hover:border-[#C8D400]/50 hover:text-[#C8D400] transition-colors flex-shrink-0 disabled:opacity-40"
          >
            <ImagePlus className="w-4 h-4" />
          </button>
          <Textarea
            ref={textareaRef}
            placeholder="Ask about rebar, place an order..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={invoicing}
            className="resize-none text-sm bg-white/5 border-white/20 text-white placeholder:text-gray-500 focus:border-[#C8D400]/50 rounded-xl flex-1"
            style={{ minHeight: "42px", maxHeight: "120px" }}
          />
          <Button
            onClick={() => send()}
            disabled={(!input.trim() && !pendingImage) || loading || invoicing}
            size="sm"
            className="bg-[#C8D400] hover:bg-[#b0bb00] text-black font-semibold h-[42px] px-4 rounded-xl flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-xs text-gray-600 mt-1.5 text-center">
          Enter to send · Shift+Enter for new line · Questions?{" "}
          <a href="tel:4696317730" className="text-[#C8D400]/70 hover:text-[#C8D400]">469-631-7730</a>
        </p>
      </div>
    </div>
  );
}
