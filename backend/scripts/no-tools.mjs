// T1: LLM with NO tools. It cannot see LiraLink's database.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const res = await client.messages.create({
  model: process.env.LLM_MODEL,
  max_tokens: 300,
  messages: [
    { role: "user", content: "Was LiraLink payment link S7473UAW paid?" },
  ],
  // no "tools" here: that's the whole point
});

console.log(
  res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n"),
);