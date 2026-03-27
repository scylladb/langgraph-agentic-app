import "dotenv/config";
import {
  Annotation,
  END,
  messagesStateReducer,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { BaseMessage } from "@langchain/core/messages";
import { SystemMessage } from "@langchain/core/messages";
import { ChatGroq } from "@langchain/groq";

// ── State definition ─────────────────────────────────────────────────────────
// messagesStateReducer appends new messages to the list rather than replacing
// it, so each invocation accumulates the full conversation history.

export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

// ── LLM ──────────────────────────────────────────────────────────────────────

const llm = new ChatGroq({ model: "llama-3.3-70b-versatile" });

const SYSTEM_PROMPT = new SystemMessage(
  "You are a helpful customer support agent for AcmeCorp. " +
    "You remember the full conversation history and use it to provide " +
    "consistent, contextual support. Be concise."
);

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function llmNode(state: typeof GraphState.State) {
  const response = await llm.invoke([SYSTEM_PROMPT, ...state.messages]);
  return { messages: [response] };
}

// ── Graph factory ─────────────────────────────────────────────────────────────
// Accepts any BaseCheckpointSaver so callers can swap ScyllaDBSaver / MemorySaver.

export function buildGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(GraphState)
    .addNode("llmNode", llmNode)
    .addEdge(START, "llmNode")
    .addEdge("llmNode", END)
    .compile({ checkpointer });
}
