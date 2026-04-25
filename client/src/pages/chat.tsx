import { useState, useRef, useEffect } from "react";
import { Send, MessageSquare, CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface OrderData {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerCompany?: string;
  deliveryAddress?: string;
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Only auto-scroll after the first message — don't hijack page scroll on mount
    if (messages.length > 1 || loading || invoice) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading, invoice]);

  const addMessage = (msg: Message) => setMessages(prev => [...prev, msg]);

  const createInvoice = async (order: OrderData) => {
    setInvoicing(true);
    try {
      const res = await fetch("/api/web-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone || "",
          customerCompany: order.customerCompany || "",
          deliveryAddress: order.deliveryAddress || "",
          items: order.items,
        }),
      });
      const data = await res.json();
      // Customer not on file — fraud prevention
      if (res.status === 403 && data.error === "customer_not_found") {
        addMessage({
          role: "assistant",
          content: `We weren’t able to verify an account for **${order.customerName}** with that phone number. To place orders online you’ll need an account on file with us.\n\nGive us a call at **469-631-7730** or stop by **2112 N Custer Rd, McKinney, TX 75071** and we’ll get you set up — it only takes a minute.`,
        });
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || "Invoice creation failed");
      setInvoice({ invoiceNumber: data.invoiceNumber, paymentLink: data.paymentLink, total: data.total });
      addMessage({
        role: "assistant",
        content: `Invoice #${data.invoiceNumber} has been created for **$${data.total.toFixed(2)}** (includes 8.25% tax).${order.customerEmail ? ` A copy has been emailed to ${order.customerEmail}.` : ""} You can also pay using the link below.`,
      });
    } catch (err: any) {
      console.error("[invoice error]", err?.message, err);
      addMessage({
        role: "assistant",
        content: `Sorry, there was an issue creating your invoice. Please call us at **469-631-7730** and we’ll get it sorted out quickly.`,
      });
    } finally {
      setInvoicing(false);
      setPendingOrder(null);
    }
  };

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setLoading(true);

    let handledByInvoice = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newHistory.map(m => ({ role: m.role, content: m.content })),
        }),
      });
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
    } catch {
      addMessage({ role: "assistant", content: "Connection error. Please try again or call us at 469-631-7730." });
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
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
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
              {renderContent(msg.content)}
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
        <div className="flex gap-2 items-end">
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
            disabled={!input.trim() || loading || invoicing}
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
