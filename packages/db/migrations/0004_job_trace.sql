-- A render is submitted by a request and run by a worker minutes later, in another process.
-- Carrying the submitting request's id on the job is what makes those two sets of log lines one
-- story: "this render was slow" becomes answerable from the request the user complained about.
alter table render_jobs add column trace_id text;

comment on column render_jobs.trace_id is
  'Request id of the submission, so web and worker logs for one render can be correlated.';
