import { useState, useRef, useEffect } from "react";
import { Send, MessageSquare, Phone, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const WELCOME: Message = {
  role: "assistant",
  content:
    "Hi! I'm the RCP Assistant. I can help you with rebar questions, material quantities, product info, and getting an order started.\n\nFor plan uploads and automated AI estimates, use the **Estimate** tab. To place a full order with invoicing, text us at **(817) 880-0900**.\n\nHow can I help you today?",
};

function renderContent(text: string) {
  // Basic markdown: **bold**, *italic*, newlines
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.filter((m) => m.role !== "assistant" || m !== WELCOME).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || "Sorry, something went wrong. Please call 469-631-7730." },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Connection error. Please try again or call us at 469-631-7730." },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
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
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "assistant" && (
              <div className="w-8 h-8 rounded-full bg-[#C8D400]/20 border border-[#C8D400]/40 flex items-center justify-center flex-shrink-0 mr-3 mt-0.5">
                <MessageSquare className="w-4 h-4 text-[#C8D400]" />
              </div>
            )}
            <div
              className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-[#C8D400] text-black rounded-tr-sm font-medium"
                  : "bg-white/5 border border-white/10 text-gray-100 rounded-tl-sm"
              }`}
            >
              {renderContent(msg.content)}
            </div>
          </div>
        ))}

        {loading && (
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
            "How much rebar do I need for a 20x20 slab?",
            "What sizes of rebar do you carry?",
            "How do I place an order?",
            "What's the difference between #3 and #4 rebar?",
          ].map((prompt) => (
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
            placeholder="Ask about rebar sizes, quantities, pricing..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            className="resize-none text-sm bg-white/5 border-white/20 text-white placeholder:text-gray-500 focus:border-[#C8D400]/50 rounded-xl flex-1"
            style={{ minHeight: "42px", maxHeight: "120px" }}
          />
          <Button
            onClick={send}
            disabled={!input.trim() || loading}
            size="sm"
            className="bg-[#C8D400] hover:bg-[#b0bb00] text-black font-semibold h-[42px] px-4 rounded-xl flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-xs text-gray-600 mt-1.5 text-center">
          Enter to send · Shift+Enter for new line · To place an order:{" "}
          <a href="sms:+18178800900" className="text-[#C8D400]/70 hover:text-[#C8D400]">
            text (817) 880-0900
          </a>
        </p>
      </div>
    </div>
  );
}
