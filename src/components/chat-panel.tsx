"use client";

import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, getToolOrDynamicToolName, isToolUIPart, type UIMessage } from "ai";
import { type FormEvent, Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { formatDate } from "@/components/map-popup";
import type { Evidence } from "@/lib/agent/contract";
import type { Bucket, ChatMetadata } from "@/lib/chat/access";
import { citeAnswer, turnEvidence } from "@/lib/chat/citations";
import { type ChatContext, REVIEWER_HEADER } from "@/lib/chat/context";
import { MAX_MESSAGE_CHARS } from "@/lib/chat/messages";
import {
	answerMissing,
	answerNotes,
	chatError,
	citationLabel,
	type Inline,
	type NumberedEvidence,
	numberedEvidence,
	parseAnswer,
	remainingNote,
	SOURCE_NAMES,
	stepLabel,
} from "@/lib/chat/ui";
import { formatTime } from "@/lib/timeline";

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

type Access = { bucket: Bucket; remaining: { hourly: number; daily: number } | null };
const ACCESS_KEY = ["chat-access"];

// The server checks the key (or the cookie): the label never shows from ?key= alone.
async function fetchAccess(): Promise<Access> {
	const response = await fetch("/api/chat/access", { headers: reviewerHeaders() });
	if (!response.ok) throw new Error(`Chat access: HTTP ${response.status}`);
	return response.json();
}

// A date-only recorded observation shows its date alone: it has no time to show.
function evidenceTime(evidence: Evidence) {
	return evidence.observedAt !== null
		? formatTime(Date.parse(evidence.observedAt))
		: evidence.observedOn && formatDate(evidence.observedOn);
}

// Chips and list labels are buttons only in the newest finished answer, whose evidence the map shows.
type OnPick = ((entry: NumberedEvidence) => void) | undefined;

function Chip({ entry, onPick }: { entry: NumberedEvidence; onPick: OnPick }) {
	const { record, number } = entry;
	const title = `${record.label}, ${evidenceTime(record)}`;
	const className = "mx-0.5 rounded bg-zinc-100 px-1 py-px text-[11px] whitespace-nowrap text-zinc-600";
	if (!onPick) {
		return (
			<span title={title} className={className}>
				{citationLabel(record.source, number)}
			</span>
		);
	}
	return (
		<button
			type="button"
			title={title}
			onClick={() => onPick(entry)}
			className={`${className} cursor-pointer hover:bg-zinc-200`}
		>
			{citationLabel(record.source, number)}
		</button>
	);
}

function InlineText({ inlines, numbered, onPick }: { inlines: Inline[]; numbered: NumberedEvidence[]; onPick: OnPick }) {
	return inlines.map((inline, index) => {
		if (inline.type === "bold") {
			return (
				<strong key={index}>
					<InlineText inlines={inline.inlines} numbered={numbered} onPick={onPick} />
				</strong>
			);
		}
		if (inline.type === "italic") return <em key={index}>{inline.text}</em>;
		if (inline.type === "citation") {
			// citeAnswer has removed every citation no tool returned, so each one left has a number.
			const entry = numbered.find(({ record }) => record.source === inline.source && record.id === inline.id);
			return entry && <Chip key={index} entry={entry} onPick={onPick} />;
		}
		return <Fragment key={index}>{inline.text}</Fragment>;
	});
}

// React elements only, never HTML: the text is the model's, so it's untrusted.
function Answer({ text, numbered, onPick }: { text: string; numbered: NumberedEvidence[]; onPick: OnPick }) {
	return parseAnswer(text).map((block, index) => {
		if (block.type === "paragraph") {
			return (
				<p key={index}>
					<InlineText inlines={block.inlines} numbered={numbered} onPick={onPick} />
				</p>
			);
		}
		if (block.type === "heading") {
			return (
				<p key={index} className="font-semibold">
					<InlineText inlines={block.inlines} numbered={numbered} onPick={onPick} />
				</p>
			);
		}
		const List = block.ordered ? "ol" : "ul";
		return (
			<List key={index} className={`space-y-0.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
				{block.items.map((item, itemIndex) => (
					<li key={itemIndex}>
						<InlineText inlines={item} numbered={numbered} onPick={onPick} />
					</li>
				))}
			</List>
		);
	});
}

/** The answer's evidence: the cited records numbered as their chips, the rest of the samples behind "Show all". */
function EvidenceList({ numbered, onPick }: { numbered: NumberedEvidence[]; onPick: OnPick }) {
	const cited = numbered.filter((entry) => entry.cited);
	const uncited = numbered.filter((entry) => !entry.cited);
	const item = (entry: NumberedEvidence) => {
		const { record, number } = entry;
		const label = (
			<>
				<span className="text-zinc-400">{citationLabel(record.source, number)}</span> {record.label}
			</>
		);
		return (
			<li key={entry.key}>
				{onPick ? (
					<button
						type="button"
						onClick={() => onPick(entry)}
						className="cursor-pointer text-left hover:text-zinc-900 hover:underline"
					>
						{label}
					</button>
				) : (
					label
				)}
				, {evidenceTime(record)}{" "}
				<a
					href={record.url}
					target="_blank"
					rel="noopener noreferrer"
					title={record.license ? `${record.attribution}, ${record.license}` : record.attribution}
					className="underline hover:text-zinc-900"
				>
					source
				</a>
			</li>
		);
	};
	return (
		<div className="space-y-1 text-xs text-zinc-600">
			<p className="font-medium text-zinc-500">Evidence</p>
			{cited.length > 0 && <ul className="space-y-0.5">{cited.map(item)}</ul>}
			{uncited.length > 0 && (
				<details className="group">
					<summary className="cursor-pointer text-zinc-500 hover:text-zinc-900">
						<span className="group-open:hidden">Show all {numbered.length}</span>
						<span className="hidden group-open:inline">Show fewer</span>
					</summary>
					<ul className="mt-0.5 space-y-0.5">{uncited.map(item)}</ul>
				</details>
			)}
		</div>
	);
}

/** Each source's coverage statement and the tools' limitations, collapsed so they don't bury the answer. */
function AnswerNotes({ notes }: { notes: ReturnType<typeof answerNotes> }) {
	if (notes.statements.length === 0 && notes.limitations.length === 0) return null;
	return (
		<details className="text-xs text-zinc-600">
			<summary className="cursor-pointer text-zinc-500 hover:text-zinc-900">Coverage and limitations</summary>
			<ul className="mt-1 list-disc space-y-0.5 pl-4">
				{notes.statements.map(({ source, statement }) => (
					<li key={`${source}:${statement}`}>
						<span className="font-medium">{SOURCE_NAMES[source]}:</span> {statement}
					</li>
				))}
				{notes.limitations.map((limitation) => (
					<li key={limitation}>{limitation}</li>
				))}
			</ul>
		</details>
	);
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

// Checked over all of the reply's text at once, so a record keeps one number across its steps.
function readReply(message: ChatMessage) {
	const evidence = turnEvidence(message);
	const textParts = message.parts.flatMap((part, index) =>
		part.type === "text" && part.text.trim() ? [{ index, text: part.text }] : [],
	);
	const answer = citeAnswer(textParts.map(({ text }) => text), evidence);
	return {
		// By part index, as the parts are rendered.
		texts: new Map(textParts.map(({ index }, i) => [index, answer.texts[i]])),
		unmatched: answer.unmatched,
		numbered: numberedEvidence(evidence, answer.cited),
		notes: answerNotes(message),
	};
}

type ReplyProps = { message: ChatMessage; finished: boolean; failed: boolean; onPick: OnPick };

function Reply({ message, finished, failed, onPick }: ReplyProps) {
	const { texts, unmatched, numbered, notes } = useMemo(() => readReply(message), [message]);

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
				const text = texts.get(index);
				if (text !== undefined) return <Answer key={index} text={text} numbered={numbered} onPick={onPick} />;
				return null;
			})}
			{/* A failed request shows its error instead. */}
			{finished && !failed && answerMissing(message) && <p className="text-zinc-500 italic">{NO_ANSWER}</p>}
			{/* Once the reply is done, so the list isn't renumbered as citations stream in. */}
			{finished && (
				<>
					{unmatched > 0 && (
						<p className="text-xs text-zinc-500">
							{unmatched} {unmatched === 1 ? "citation" : "citations"} couldn&apos;t be matched to a tool result
						</p>
					)}
					{numbered.length > 0 && <EvidenceList numbered={numbered} onPick={onPick} />}
					<AnswerNotes notes={notes} />
				</>
			)}
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
	// The evidence the map marks: the newest finished answer's, or none.
	onHighlight: (evidence: NumberedEvidence[]) => void;
	// A chip or evidence list item was picked: the map flies to the record and opens it.
	onFocus: (entry: NumberedEvidence) => void;
};

const NO_EVIDENCE: NumberedEvidence[] = [];

// Memoized: the map re-renders on every pointer move over it.
export const ChatPanel = memo(function ChatPanel({ context, suggestions, onHighlight, onFocus }: ChatPanelProps) {
	const queryClient = useQueryClient();
	const access = useQuery({ queryKey: ACCESS_KEY, queryFn: fetchAccess, staleTime: Infinity });
	// Each request uses up a question, so the count is fetched again once it's done.
	const refreshAccess = () => void queryClient.invalidateQueries({ queryKey: ACCESS_KEY });
	const { messages, sendMessage, setMessages, clearError, status, error } = useChat<ChatMessage>({
		transport,
		onFinish: refreshAccess,
		onError: refreshAccess,
	});
	const [input, setInput] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const busy = status === "submitted" || status === "streaming";
	const failure = error ? chatError(error) : null;
	const bucket =
		access.data?.bucket ?? failure?.bucket ?? messages.findLast((message) => message.metadata?.bucket)?.metadata?.bucket;
	const remaining = remainingNote(access.data?.remaining ?? null);

	// Only the newest reply's evidence is marked, once it's finished, until it's cleared.
	const last = messages.at(-1);
	const newest = !busy && last?.role === "assistant" ? last : null;
	const [clearedId, setClearedId] = useState<string | null>(null);
	const newestEvidence = useMemo(() => (newest ? readReply(newest).numbered : NO_EVIDENCE), [newest]);
	const highlighted = newest && newest.id !== clearedId ? newestEvidence : NO_EVIDENCE;
	// The markers live in the map; handing them over here keeps the messages out of its state.
	useEffect(() => onHighlight(highlighted), [highlighted, onHighlight]);
	const pick = (entry: NumberedEvidence) => {
		setClearedId(null);
		onFocus(entry);
	};

	// Keeps the newest step or line in view as the reply streams.
	useEffect(() => {
		const element = scrollRef.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [messages, status, error]);

	// One question at a time: a second one mid-answer would use a quota slot and interleave replies.
	const send = (text: string) => {
		const question = text.trim();
		if (!question || busy) return;
		const asked = context();
		// Stored on the question too, so later turns can say which view its answer described.
		void sendMessage(
			{ text: question, metadata: { context: asked } },
			{ body: { context: asked }, headers: reviewerHeaders() },
		);
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
			<header className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
				<div className="flex items-center gap-2">
					<h2 className="font-semibold">Ask about the data</h2>
					{/* Clears the conversation and brings the suggestions back; not mid-reply. */}
					<button
						type="button"
						onClick={() => {
							setMessages([]);
							clearError();
						}}
						disabled={busy || (messages.length === 0 && !error)}
						className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent"
					>
						New chat
					</button>
					<button
						type="button"
						onClick={() => setClearedId(newest?.id ?? null)}
						disabled={highlighted.length === 0}
						className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent"
					>
						Clear highlights
					</button>
				</div>
				<div className="flex items-center gap-2 text-xs">
					{remaining && <span className="text-zinc-500">{remaining}</span>}
					{bucket === "reviewer" && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600">Reviewer access</span>}
				</div>
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
							onPick={message === newest ? pick : undefined}
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
