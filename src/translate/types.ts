// Only the fields we translate; everything else is dropped.

export type OAIPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | OAIPart[];
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIChatReq {
  model: string;
  messages: OAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: { type: "function"; function: { name: string; description?: string; parameters?: unknown } }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
}

export type OAIFinishReason = "stop" | "tool_calls" | "length";

export interface OpenAIChatRes {
  id?: string;
  object?: "chat.completion";
  created?: number;
  model: string;
  choices: { index: number; message: OAIMessage; finish_reason: OAIFinishReason | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export type AnthropicBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicBlock[] };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicReq {
  model: string;
  messages: AnthropicMessage[];
  system?: string | { type: "text"; text: string }[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: { name: string; description?: string; input_schema: unknown }[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string };
}

export type AnthropicStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface AnthropicRes {
  id?: string;
  type?: "message";
  role?: "assistant";
  model: string;
  content: AnthropicBlock[];
  stop_reason: AnthropicStopReason | null;
  usage?: { input_tokens: number; output_tokens: number };
}
