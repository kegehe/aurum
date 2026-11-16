import { describe, expect, it } from 'vitest';
import { collectTailwindClasses } from './tailwind-classes';

describe('collectTailwindClasses', () => {
  it('collects static className and cn() classes', () => {
    const classes = collectTailwindClasses([
      {
        path: 'files/button.tsx',
        content:
          "export function Button({ active }) { return <button className={cn('px-4', active && 'bg-sky-500', { 'text-sm': true })} />; }",
      },
    ]);
    expect(classes).toContain('px-4');
    expect(classes).toContain('bg-sky-500');
    expect(classes).toContain('text-sm');
  });

  it('merges explicit tailwindClasses with scanned ones', () => {
    expect(
      collectTailwindClasses([{ path: 'a.tsx', content: "className={cn('scanned')}" }], [
        'declared',
      ]),
    ).toEqual(expect.arrayContaining(['declared', 'scanned']));
  });

  it('skips dynamic template fragments', () => {
    const classes = collectTailwindClasses([
      {
        path: 'a.tsx',
        content: "className={`px-4 ${active ? 'bg-red-500' : 'bg-blue-500'}`}",
      },
    ]);
    expect(classes).toContain('px-4');
  });
});
