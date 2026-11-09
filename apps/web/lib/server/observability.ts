import 'server-only';
import { log, newRequestId, withLogContext } from '@pr/observability';
import { handleRouteError } from './http.js';

/**
 * The wrapper every API route goes through (F-PLAT-02).
 *
 * Three things that were previously the caller's problem, done once: a request id that survives
 * into every line the request logs, one line per request saying what happened and how long it took,
 * and the single catch that turns an error into the coarse response vocabulary.
 *
 * The id is taken from `x-request-id` when a proxy already assigned one, so a trace does not
 * restart at our edge, and it is echoed back on the response — a user reporting "it failed" can
 * hand over the id from the network tab and be found in one query.
 */

type Handler<C> = (request: Request, context: C) => Promise<Response>;

export function route<C>(name: string, handler: Handler<C>): Handler<C> {
  return async (request: Request, context: C): Promise<Response> => {
    const requestId = request.headers.get('x-request-id') ?? newRequestId();
    const path = new URL(request.url).pathname;
    const logger = log.child({ requestId, route: name, method: request.method, path });
    const started = Date.now();

    return withLogContext(logger, async () => {
      let response: Response;
      try {
        response = await handler(request, context);
      } catch (error) {
        response = handleRouteError(error);
      }

      const ms = Date.now() - started;
      const fields = { status: response.status, ms };
      // A 4xx is the client being told no, which is worth seeing but is not a fault; a 5xx is ours.
      if (response.status >= 500) logger.error('request failed', undefined, fields);
      else if (response.status >= 400) logger.warn('request refused', fields);
      else logger.info('request', fields);

      response.headers.set('x-request-id', requestId);
      return response;
    });
  };
}
