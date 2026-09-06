import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConsoleLogger } from '../../src/panel/infra/console-logger.js';

describe('ConsoleLogger', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    outSpy?.mockRestore();
    errSpy?.mockRestore();
    vi.useRealTimers();
  });

  function setup() {
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  it('json format writes all levels and filters below threshold', () => {
    setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    const log = new ConsoleLogger({ level: 'info', format: 'json' });
    log.info('hello', { a: 1 });
    log.debug('hidden'); // below info threshold
    log.error('oops', { b: 2 });
    const out = outSpy.mock.calls.map((c) => c[0] as string).join('');
    const err = errSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(out).toContain('"level":"info"');
    expect(out).toContain('"msg":"hello"');
    expect(out).toContain('"a":1');
    expect(out).not.toContain('hidden');
    expect(err).toContain('"level":"error"');
    expect(err).toContain('"b":2');
  });

  it('pretty format with merged bindings and object formatting', () => {
    setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    const log = new ConsoleLogger({ level: 'debug', format: 'pretty', bindings: { reqId: 'r1' } });
    log.debug('dbg');
    log.warn('warn', { obj: { x: 1 }, nullv: null });
    const out = outSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(out).toContain('DEBUG');
    expect(out).toContain('WARN ');
    expect(out).toContain('reqId=r1');
    expect(out).toContain('obj={"x":1}');
    expect(out).toContain('nullv=null');
  });

  it('child accumulates bindings', () => {
    setup();
    const parent = new ConsoleLogger({ level: 'info', format: 'json', bindings: { a: 1 } });
    const child = parent.child({ b: 2 }) as unknown as ConsoleLogger;
    child.info('child-msg');
    const out = outSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(out).toContain('"a":1');
    expect(out).toContain('"b":2');
    expect(out).toContain('child-msg');
  });

  it('warn below threshold filtered when level=error', () => {
    setup();
    const log = new ConsoleLogger({ level: 'error', format: 'json' });
    log.warn('no');
    log.info('no');
    log.error('yes');
    expect(outSpy.mock.calls.length).toBe(0);
    expect(errSpy.mock.calls.length).toBe(1);
  });
});