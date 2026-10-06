/**
 * Manual pairing aid: runs the reference receiver and prints what the app sends.
 *
 *   node test/receiver-cli.ts [--port 8790] [--host 0.0.0.0] [--token <token>]
 *
 * (Node >= 22.18 runs TypeScript directly.) This is not the kineReqLens desktop integration; it only shows
 * that an app is connected and streaming.
 */
import { startReceiver } from './receiver.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const receiver = await startReceiver({
  port: Number(arg('port') ?? 8790),
  host: arg('host') ?? '0.0.0.0',
  token: arg('token') ?? process.env.KINEREQLENS_TOKEN,
});

console.log(`kineReqLens reference receiver on ${receiver.url}`);
console.log(`pairing token: ${receiver.token}`);
console.log(`app: startKineReqLens({ token: '${receiver.token}' })`);

receiver.on('client', (client) => {
  const app = client.hello?.app;
  console.log(`+ ${app?.name} (${app?.bundleId || 'unknown bundle'}) ${app?.platform} RN ${app?.rnVersion} on ${app?.deviceName}`);
});
receiver.on('rejected', (r: { reason: string }) => console.log(`! rejected: ${r.reason}`));
receiver.on('disconnect', () => console.log('- app disconnected'));
receiver.on('message', (message) => {
  switch (message.t) {
    case 'start':
      console.log(`> ${message.data.kind} ${message.data.method} ${message.data.url}`);
      break;
    case 'end':
      console.log(`< ${message.data.state} ${message.data.status ?? ''} ${message.data.hookId}`);
      break;
    case 'ws-open':
      console.log(`ws open ${message.data.url}`);
      break;
    case 'ws-frame':
      console.log(`ws ${message.data.dir} ${message.data.opcode} ${message.data.size} B`);
      break;
    case 'ws-close':
      console.log(`ws close ${message.data.code ?? ''} (${message.data.initiator})`);
      break;
    case 'open-ui':
      console.log('open-ui requested from the dev menu');
      break;
    default:
      console.log(message.t);
  }
});
