/**
 * Structured logging (F-PLAT-02).
 *
 * One record per event, as JSON, with the fields that let you find it again: request id, org, user,
 * design, job. Log lines are the only description of what production did, so they are built from
 * data rather than from sentences — `log.info('render finished', { jobId, ms })` can be grouped and
 * counted; "Render 3f2a finished in 41s" cannot.
 *
 * There is no logging library here because the requirements are small and the alternative is a
 * dependency in every package that wants to say something.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

export type Fields = Record<string, unknown>;

export interface LogRecord {
  time: string;
  level: Level;
  message: string;
  fields: Fields;
  /** Present on `error`, already flattened: an Error does not survive JSON.stringify. */
  error?: { name: string; message: string; stack?: string };
}

export type Sink = (record: LogRecord) => void;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names whose values never reach a log, whatever they hold.
 *
 * Tokens are the reason: an invitation link in a log file is an invitation anyone with log access
 * can accept. Matching is on the key, so a caller cannot leak one by accident through a field name
 * that merely contains it.
 */
const SECRET_KEY = /(token|password|secret|cookie|authorization|apikey|api_key)/i;

export function redact(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) out[key] = '[redacted]';
    else if (value instanceof Error) out[key] = value.message;
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redact(value as Fields);
    } else out[key] = value;
  }
  return out;
}

/** Where records go when nothing says otherwise: JSON lines on stdout, one per event. */
export function jsonSink(write: (line: string) => void = (line) => process.stdout.write(line)): Sink {
  return (record) => {
    write(`${JSON.stringify(record)}\n`);
  };
}

/**
 * A sink for a terminal, where JSON is unreadable and the fields are usually the point.
 */
export function prettySink(write: (line: string) => void = (line) => process.stdout.write(line)): Sink {
  return (record) => {
    const fields = Object.entries(record.fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const error = record.error ? ` ${record.error.name}: ${record.error.message}` : '';
    write(`${record.level.padEnd(5)} ${record.message}${fields ? ` ${fields}` : ''}${error}\n`);
  };
}

export interface LoggerOptions {
  level?: Level;
  sink?: Sink;
  fields?: Fields;
  now?: () => Date;
}

/**
 * Somewhere to send problems besides the log — the service event log the status page reads, Sentry,
 * or whatever replaces them.
 *
 * A seam rather than an integration: the call sites are already correct, and swapping the reporter
 * is a line in the server's startup rather than an edit to every catch. Warnings come through too,
 * with no error: a worker sweeping up after a dead one, or mail that did not go, is how an operator
 * learns something is wrong before it is an error.
 */
export type ErrorReporter = (error: unknown, fields: Fields, level: 'warn' | 'error') => void;

/**
 * Held on globalThis rather than in this module: a bundler can load this module more than once in
 * one process — Next.js compiles its instrumentation hook and each route separately — and a
 * reporter installed through one copy has to reach the loggers of every other.
 */
const REPORTER = Symbol.for('pr.observability.errorReporter');
const holder = globalThis as unknown as { [REPORTER]?: ErrorReporter | null };

export function setErrorReporter(reporter: ErrorReporter | null): void {
  holder[REPORTER] = reporter;
}

export class Logger {
  private readonly level: Level;
  private readonly sink: Sink;
  private readonly bound: Fields;
  private readonly now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? defaultLevel();
    this.sink = options.sink ?? defaultSink();
    this.bound = options.fields ?? {};
    this.now = options.now ?? (() => new Date());
  }

  /** The fields bound to this logger, for the rare caller that needs one of them back. */
  get fields(): Readonly<Fields> {
    return this.bound;
  }

  /** A logger that carries these fields on every record — the request id, the job id, the org. */
  child(fields: Fields): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      fields: { ...this.bound, ...fields },
      now: this.now,
    });
  }

  /** A logger that also hands every record it writes to `sink` — a job keeping its own log lines. */
  tee(sink: Sink): Logger {
    const own = this.sink;
    return new Logger({
      level: this.level,
      sink: (record) => {
        own(record);
        sink(record);
      },
      fields: this.bound,
      now: this.now,
    });
  }

  debug(message: string, fields: Fields = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: Fields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: Fields = {}): void {
    this.write('warn', message, fields);
    holder[REPORTER]?.(undefined, redact({ ...this.bound, ...fields, message }), 'warn');
  }

  error(message: string, error?: unknown, fields: Fields = {}): void {
    this.write('error', message, fields, error);
    holder[REPORTER]?.(error, redact({ ...this.bound, ...fields, message }), 'error');
  }

  /**
   * Times an operation and logs how it ended — the poor relation of a span, and enough to answer
   * "which stage is slow" without a tracing backend.
   */
  async time<T>(message: string, fn: () => Promise<T>, fields: Fields = {}): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.info(message, { ...fields, ms: Date.now() - started, outcome: 'ok' });
      return result;
    } catch (error) {
      this.error(message, error, { ...fields, ms: Date.now() - started, outcome: 'error' });
      throw error;
    }
  }

  private write(level: Level, message: string, fields: Fields, error?: unknown): void {
    if (LEVELS[level] < LEVELS[this.level]) return;

    const record: LogRecord = {
      time: this.now().toISOString(),
      level,
      message,
      fields: redact({ ...this.bound, ...fields }),
    };
    if (error !== undefined) record.error = flatten(error);
    this.sink(record);
  }
}

function flatten(error: unknown): NonNullable<LogRecord['error']> {
  if (error instanceof Error) {
    const flat: NonNullable<LogRecord['error']> = { name: error.name, message: error.message };
    if (error.stack) flat.stack = error.stack;
    return flat;
  }
  return { name: 'NonError', message: String(error) };
}

function defaultLevel(): Level {
  const configured = process.env['LOG_LEVEL'];
  if (configured && configured in LEVELS) return configured as Level;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function defaultSink(): Sink {
  return process.env.NODE_ENV === 'production' || process.env['LOG_FORMAT'] === 'json'
    ? jsonSink()
    : prettySink();
}

/** The process-wide logger. Prefer a `child` carrying the ids for whatever you are doing. */
export const log = new Logger();
