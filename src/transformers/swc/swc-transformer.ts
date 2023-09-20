import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';

import getCacheKeyFunction from '@jest/create-cache-key-function';
import type { Transformer, TransformOptions } from '@jest/transform';
import { transformSync, transform, Options, version as swcVersion } from '@swc/core';
import { parse as parseJsonC, type ParseError } from 'jsonc-parser';

const version = '0.2.26';

interface CustomCoverageInstrumentation {
  enabled: boolean;
  coverageVariable?: string;
  compact?: boolean;
  reportLogic?: boolean;
  ignoreClassMethods?: string[];
  instrumentLog?: { level: string; enableTrace: boolean };
}

export function createTransformer(
  swcTransformOpts?: Options & {
    experimental?: {
      customCoverageInstrumentation?: CustomCoverageInstrumentation;
    };
  },
): Transformer {
  const computedSwcOptions = buildSwcTransformOpts(swcTransformOpts);

  const cacheKeyFunction = getCacheKeyFunction([], [swcVersion, version, JSON.stringify(computedSwcOptions)]);
  const { enabled: canInstrument, ...instrumentOptions } =
    swcTransformOpts?.experimental?.customCoverageInstrumentation ?? {};

  return {
    canInstrument: !!canInstrument, // Tell jest we'll instrument by our own
    process(src, filename, jestOptions) {
      // Determine if we actually instrument codes if jest runs with --coverage
      insertInstrumentationOptions(jestOptions, !!canInstrument, computedSwcOptions, instrumentOptions);

      return transformSync(src, {
        ...computedSwcOptions,
        module: {
          ...computedSwcOptions.module,
          type: jestOptions.supportsStaticESM ? 'es6' : 'commonjs',
        },
        filename,
      });
    },
    processAsync(src, filename, jestOptions) {
      insertInstrumentationOptions(jestOptions, !!canInstrument, computedSwcOptions, instrumentOptions);

      return transform(src, {
        ...computedSwcOptions,
        module: {
          ...computedSwcOptions.module,
          // async transform is always ESM
          type: 'es6',
        },
        filename,
      });
    },

    getCacheKey(src, filename, ...rest) {
      // @ts-expect-error - type overload is confused
      const baseCacheKey = cacheKeyFunction(src, filename, ...rest);

      // @ts-expect-error - signature mismatch between Jest <27 og >=27
      const options: TransformOptions = typeof rest[0] === 'string' ? rest[1] : rest[0];

      return crypto
        .createHash('md5')
        .update(baseCacheKey)
        .update('\0', 'utf8')
        .update(JSON.stringify({ supportsStaticESM: options.supportsStaticESM }))
        .digest('hex');
    },
  };
}

function getOptionsFromSwrc(): Options {
  const swcrc = path.join(process.cwd(), '.swcrc');
  if (fs.existsSync(swcrc)) {
    const errors = [] as ParseError[];
    const options = parseJsonC(fs.readFileSync(swcrc, 'utf-8'), errors);

    if (errors.length > 0) {
      throw new Error(`Error parsing ${swcrc}: ${errors.join(', ')}`);
    }

    return options;
  }

  return {};
}

function buildSwcTransformOpts(swcOptions: (Options & { experimental?: unknown }) | undefined): Options {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { experimental, ...computedSwcOptions } =
    swcOptions || (getOptionsFromSwrc() as Options & { experimental?: unknown });

  if (!computedSwcOptions.env && !computedSwcOptions.jsc?.target) {
    set(computedSwcOptions, 'jsc.target', 'es2016');
  }

  set(computedSwcOptions, 'jsc.transform.hidden.jest', true);

  if (!computedSwcOptions.sourceMaps) {
    set(computedSwcOptions, 'sourceMaps', 'inline');
  }

  if (computedSwcOptions.jsc?.baseUrl) {
    set(computedSwcOptions, 'jsc.baseUrl', path.resolve(computedSwcOptions.jsc.baseUrl));
  }

  return computedSwcOptions;
}

function insertInstrumentationOptions(
  jestOptions: TransformOptions<unknown>,
  canInstrument: boolean,
  swcTransformOpts: Options,
  instrumentOptions?: Omit<CustomCoverageInstrumentation, 'enabled'>,
): void {
  const shouldInstrument = jestOptions.instrument && canInstrument;

  if (!shouldInstrument) {
    return;
  }

  if (swcTransformOpts?.jsc?.experimental?.plugins?.some((x) => x[0] === 'swc-plugin-coverage-instrument')) {
    return;
  }

  if (!swcTransformOpts.jsc) {
    swcTransformOpts.jsc = {};
  }

  if (!swcTransformOpts.jsc.experimental) {
    swcTransformOpts.jsc.experimental = {};
  }

  if (!Array.isArray(swcTransformOpts.jsc.experimental.plugins)) {
    swcTransformOpts.jsc.experimental.plugins = [];
  }

  swcTransformOpts.jsc.experimental.plugins?.push(['swc-plugin-coverage-instrument', instrumentOptions ?? {}]);
}

function set(obj: Record<string, unknown>, path: string, value: unknown): void {
  let o = obj;
  const parents = path.split('.');
  const key = parents.pop() as string;

  for (const prop of parents) {
    if (o[prop] == null) o[prop] = {};
    o = o[prop] as Record<string, unknown>;
  }

  o[key] = value;
}
