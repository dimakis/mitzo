// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ServiceStatus } from '../ServiceStatus';

// Mock useServiceHealth
let mockReturn = {
  services: [] as any[],
  yapper: null as any,
  contexgin: null as any,
  checkedAt: 0,
};

vi.mock('../../hooks/useServiceHealth', () => ({
  useServiceHealth: () => mockReturn,
}));

describe('ServiceStatus', () => {
  beforeEach(() => {
    mockReturn = { services: [], yapper: null, contexgin: null, checkedAt: 0 };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing before first health check', () => {
    const { container } = render(<ServiceStatus />);
    expect(container.firstChild).toBeNull();
  });

  it('renders service dots after health check', () => {
    mockReturn = {
      services: [],
      yapper: { name: 'yapper', ok: true },
      contexgin: { name: 'contexgin', ok: false },
      checkedAt: Date.now(),
    };

    const { container } = render(<ServiceStatus />);
    const dots = container.querySelectorAll('.service-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0].textContent).toBe('yapper');
    expect(dots[1].textContent).toBe('contexgin');
  });

  it('shows green indicator for ok services', () => {
    mockReturn = {
      services: [],
      yapper: { name: 'yapper', ok: true },
      contexgin: null,
      checkedAt: Date.now(),
    };

    const { container } = render(<ServiceStatus />);
    const dot = container.querySelector('.service-dot') as HTMLElement;
    expect(dot.style.color).toBe('rgb(74, 222, 128)');
  });

  it('shows red indicator for down services', () => {
    mockReturn = {
      services: [],
      yapper: null,
      contexgin: { name: 'contexgin', ok: false },
      checkedAt: Date.now(),
    };

    const { container } = render(<ServiceStatus />);
    const dot = container.querySelector('.service-dot') as HTMLElement;
    expect(dot.style.color).toBe('rgb(255, 109, 109)');
  });

  it('renders nothing when both services are null', () => {
    mockReturn = { services: [], yapper: null, contexgin: null, checkedAt: Date.now() };
    const { container } = render(<ServiceStatus />);
    expect(container.firstChild).toBeNull();
  });
});
