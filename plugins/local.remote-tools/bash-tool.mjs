import { Type } from 'typebox';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from './transport.mjs';

const MAX_OUTPUT_BYTES = 50 * 1024;

export function createBashToolDefinition(cwd, options = {}) {
  return {
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute on the remote host', minLength: 1 }),
      timeout: Type.Optional(Type.Number({ description: `Overall timeout in seconds, including SSH setup; default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}`, minimum: 1, maximum: MAX_TIMEOUT_SECONDS })),
    }),
    async execute(_id, params, signal, onUpdate) {
      if (!options.operations?.exec) throw new Error('Remote Bash operations are unavailable');
      let output = Buffer.alloc(0);
      let totalBytes = 0;
      let lastUpdate = 0;
      const result = (exitCode, complete = true) => {
        const truncated = totalBytes > output.length;
        let start = 0;
        if (truncated) {
          while (start < Math.min(3, output.length) && (output[start] & 0xC0) === 0x80) start++;
        }
        const decoder = new StringDecoder('utf8');
        const visible = output.subarray(start);
        const decoded = complete ? decoder.end(visible) : decoder.write(visible);
        const text = `${truncated ? '[Output truncated: last 50 KiB shown]\n' : ''}${decoded || '(no output)'}`;
        return { content: [{ type: 'text', text }], details: { host: params.host, exitCode, truncated, totalBytes } };
      };
      const { exitCode } = await options.operations.exec(params.command, cwd, {
        signal,
        timeout: params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        onData(data) {
          totalBytes += data.length;
          const combined = Buffer.concat([output, data]);
          output = Buffer.from(combined.subarray(Math.max(0, combined.length - MAX_OUTPUT_BYTES)));
          if (onUpdate && Date.now() - lastUpdate >= 100) {
            lastUpdate = Date.now();
            onUpdate(result(null, false));
          }
        },
      });
      const final = result(exitCode);
      if (exitCode !== 0) throw new Error(`Remote command exited ${exitCode ?? 'by signal'} on ${params.host}\n${final.content[0].text}`);
      return final;
    },
  };
}
