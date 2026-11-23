import { z } from 'zod';
import {
  ERROR_CODES,
  HEADERS,
  METHODS,
  PROTOCOL_VERSION,
  REQUEST_SCHEMAS,
  RESPONSE_SCHEMAS,
  RESERVED_ATTRIBUTES,
  errorResponseSchema,
} from './protocol.js';

/**
 * The protocol as JSON Schema (2020-12), for authors who build a service in
 * another language. Generated from the same zod schemas both ends validate
 * against; `protocol.schema.json` is this, committed.
 *
 * The one rule JSON Schema cannot say is written beside it: attribute names
 * in `x-reservedAttributes` are refused, compared case-insensitively.
 */
export function protocolJsonSchema(): Record<string, unknown> {
  const convert = (schema: z.ZodType, io: 'input' | 'output') => {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as Record<
      string,
      unknown
    >;
    return rest;
  };
  const methods: Record<string, unknown> = {};
  for (const method of METHODS) {
    methods[method] = {
      path: `/${method}`,
      httpMethod: 'POST',
      request: convert(REQUEST_SCHEMAS[method], 'input'),
      response: convert(RESPONSE_SCHEMAS[method], 'output'),
    };
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Syntra connector protocol',
    'x-protocolVersion': PROTOCOL_VERSION,
    'x-headers': HEADERS,
    'x-signature': 'HMAC-SHA256(secret, "v1\\n" + timestamp + "\\n" + nonce + "\\n" + method + "\\n" + hex(sha256(body))), sent as "v1=<hex>"',
    'x-reservedAttributes': RESERVED_ATTRIBUTES,
    'x-errorStatus': ERROR_CODES,
    'x-methods': methods,
    $defs: { error: convert(errorResponseSchema, 'output') },
  };
}
