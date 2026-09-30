"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolOrDynamicToolName, isToolUIPart, type UIMessage } from "ai";
import { type FormEvent, Fragment, memo, useEffect, useRef, useState } from "react";
import type { ChatMetadata } from "@/lib/chat/access";
import { type ChatContext, REVIEWER_HEADER } from "@/lib/chat/context";
import { MAX_MESSAGE_CHARS } from "@/lib/chat/messages";
import { answerMissing, chatError, type Inline, parseAnswer, stepLabel } from "@/lib/chat/ui";

type ChatMessage = UIMessage<ChatMetadata>;

const NO_ANSWER = "Couldn't finish this one. Try a narrower question.";
// The character count shows once a question gets this close to the limit.
const COUNTER_FROM = MAX_MESSAGE_CHARS * 0.8;

// The route reads only the last two answered turns; a few more cover questions it turned away in
// between. Sending just these keeps each request small, and a long session under the route's
// 200-message cap.
const SENT_MESSAGES = 10;
const transport = new DefaultChatTransport<ChatMessage>({
	prepareSendMessagesRequest: ({ messages, body, headers }) => ({
		body: { ...body, messages: messages.slice(-SENT_MESSAGES) },
		headers,
	}),
});

// Reviewers open the demo with ?key=…; after the first answer the route's cookie also carries it.
function reviewerHeaders(): Record<string, string> {
	const key = new URLSearchParams(window.location.search).get("key");
	return key ? { [REVIEWER_HEADER]: key } : {};
}

function InlineText({ inlines }: { inlines: Inline[] }) {
	return inlines.map((inline, index) =>
		inline.type === "bold" ? (
			<strong key={index}>{inline.text}</strong>
		) : inline.type === "citation" ? (
			// Muted until 10c turns the ones a tool returned into links to the record.
			<span key={index} className="text-[11px] text-zinc-400">
				[{inline.source}:{inline.id}]
			</span>
		) : (
			<Fragment key={index}>{inline.text}</Fragment>
		),
	);
}

// React elements only, never HTML: the text is the model's, so it's untrusted.
function Answer({ text }: { text: string }) {
	return parseAnswer(text).map((block, index) => {
		if (block.type === "paragraph") {
			return (
				<p key={index}>
					<InlineText inlines={block.inlines} />
				</p>
			);
		}
		const List = block.ordered ? "ol" : "ul";
		return (
			<List key={index} className={`space-y-0.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
				{block.items.map((item, itemIndex) => (
					<li key={itemIndex}>
						<InlineText inlines={item} />
					</li>
				))}
			</List>
		);
	});
}

function Spinner() {
	return <span className="inline-block size-3 animate-spin rounded-full border border-zinc-300 border-t-zinc-600" />;
}

/** One tool call: running while the reply streams, then done, or failed if it errored or never finished. */
function Step({ name, state, finished }: { name: string; state: string; finished: boolean }) {
	const done = state === "output-available";
	const failed = !done && (finished || state === "output-error" || state === "output-denied");
	return (
		<p className="flex items-center gap-1.5 text-xs text-zinc-500">
			<span aria-hidden className="flex w-3 justify-center">
				{done ? "✓" : failed ? "✕" : <Spinner />}
			</span>
			{stepLabel(name)}
			{failed ? " (failed)" : done ? "" : "…"}
		</p>
	);
}

function Reply({ message, finished, failed }: { message: ChatMessage; finished: boolean; failed: boolean }) {
	return (
		<div className="space-y-2">
			{message.parts.map((part, index) => {
				if (isToolUIPart(part)) {
					return (
						<Step
							key={part.toolCallId}
							name={getToolOrDynamicToolName(part)}
							state={part.state}
							finished={finished}
						/>
					);
				}
				// Reasoning parts (empty text plus a signature) and step markers aren't shown.
				if (part.type === "text" && part.text.trim()) return <Answer key={index} text={part.text} />;
				return null;
			})}
			{/* A failed request shows its error instead. */}
			{finished && !failed && answerMissing(message) && <p className="text-zinc-500 italic">{NO_ANSWER}</p>}
		</div>
	);
}

/** Between the question and the first part, and between one step's tools and the next step's text. */
function waiting(messages: ChatMessage[]) {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return true;
	const shown = last.parts.filter((part) => isToolUIPart(part) || (part.type === "text" && part.text.trim()));
	const lastShown = shown.at(-1);
	return !lastShown || (isToolUIPart(lastShown) && lastShown.state === "output-available");
}

type ChatPanelProps = {
	// Read when a question is sent: the map view, window and timeline as they are then.
	context: () => ChatContext;
	// Only the questions the loaded data can answer, offered while the chat is empty.
	suggestions: string[];
};

// Memoized: the map re-renders on every pointer move over it.
export const ChatPanel = memo(function ChatPanel({ context, suggestions }: ChatPanelProps) {
	const { messages, sendMessage, status, error } = useChat<ChatMessage>({ transport });
	const [input, setInput] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const busy = status === "submitted" || status === "streaming";
	const failure = error ? chatError(error) : null;
	const bucket = failure?.bucket ?? messages.findLast((message) => message.metadata)?.metadata?.bucket;

	// Keeps the newest step or line in view as the reply streams.
	useEffect(() => {
		const element = scrollRef.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [messages, status, error]);

	// One question at a time: a second one mid-answer would use a quota slot and interleave replies.
	const send = (text: string) => {
		const question = text.trim();
		if (!question || busy) return;
		void sendMessage({ text: question }, { body: { context: context() }, headers: reviewerHeaders() });
		setInput("");
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		send(input);
	};

	return (
		<section
			aria-label="Chat"
			className="pointer-events-auto flex min-h-0 w-96 flex-col rounded-lg bg-white/95 text-sm text-zinc-900 shadow-md"
		>
			<header className="flex items-center justify-between gap-2 px-3 pt-3">
				<h2 className="font-semibold">Ask about the data</h2>
				{bucket === "reviewer" && (
					<span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">Reviewer access</span>
				)}
			</header>

			<div ref={scrollRef} className="min-h-0 space-y-3 overflow-y-auto p-3">
				{messages.length === 0 && (
					<div className="space-y-2">
						<p className="text-zinc-600">
							Answers are counted from the stored data for the map&apos;s current view and time window.
						</p>
						<div className="flex flex-col items-start gap-1.5">
							{suggestions.map((question) => (
								<button
									key={question}
									type="button"
									onClick={() => send(question)}
									className="rounded-md border border-zinc-200 px-2 py-1 text-left text-zinc-700 hover:bg-zinc-100"
								>
									{question}
								</button>
							))}
						</div>
					</div>
				)}
				{messages.map((message, index) => {
					const isLast = index === messages.length - 1;
					return message.role === "user" ? (
						<p key={message.id} className="ml-8 rounded-lg bg-zinc-100 px-3 py-2 whitespace-pre-wrap">
							{message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
						</p>
					) : (
						<Reply
							key={message.id}
							message={message}
							finished={!(isLast && busy)}
							failed={isLast && failure !== null}
						/>
					);
				})}
				{busy && waiting(messages) && (
					<p className="flex items-center gap-1.5 text-xs text-zinc-500">
						<Spinner />
						Thinking…
					</p>
				)}
				{failure && <p className="rounded-md bg-red-50 px-3 py-2 text-red-800">{failure.message}</p>}
			</div>

			<form onSubmit={onSubmit} className="shrink-0 space-y-1 border-t border-zinc-200 p-3">
				<div className="flex items-end gap-2">
					<textarea
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
							event.preventDefault();
							send(input);
						}}
						disabled={busy}
						maxLength={MAX_MESSAGE_CHARS}
						rows={2}
						placeholder="Ask about recorded observations, thermal detections or conditions"
						aria-label="Question"
						className="min-w-0 flex-1 resize-none rounded-md border border-zinc-200 px-2 py-1 disabled:bg-zinc-50"
					/>
					<button
						type="submit"
						disabled={busy || !input.trim()}
						className="rounded-md bg-zinc-900 px-3 py-1.5 text-white disabled:bg-zinc-300"
					>
						Send
					</button>
				</div>
				{input.length >= COUNTER_FROM && (
					<p className="text-right text-xs text-zinc-500">
						{input.length.toLocaleString("en-US")} / {MAX_MESSAGE_CHARS.toLocaleString("en-US")}
					</p>
				)}
			</form>
		</section>
	);
});
