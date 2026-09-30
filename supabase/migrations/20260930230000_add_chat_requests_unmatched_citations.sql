-- How many distinct [source:id] citations in the reply no tool in the turn returned (decisions.md,
-- 38): the panel strips them and says how many, and this keeps the rate measurable. Null when
-- the reply was cut off or failed, like no_answer.
alter table chat_requests add column unmatched_citations integer check (unmatched_citations >= 0);
