export const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};
export const fv = (id: string) => +$<HTMLInputElement>(id).value;

export interface NumBox { value: number; set(x: number): void }

// LED number display. Change with −/+, mouse wheel, or vertical drag
export function numbox(el: HTMLElement, min: number, max: number, val: number, onChange?: (v: number) => void): NumBox {
  el.className = 'num';
  el.innerHTML = '<button aria-label="down">−</button><span class="led"></span><button aria-label="up">+</button>';
  const [dn, led, up] = el.children as unknown as [HTMLButtonElement, HTMLSpanElement, HTMLButtonElement];
  const set = (x: number) => {
    box.value = Math.max(min, Math.min(max, Math.round(x)));
    led.textContent = String(box.value);
    onChange?.(box.value);
  };
  const box: NumBox = { value: val, set };
  dn.onclick = () => set(box.value - 1);
  up.onclick = () => set(box.value + 1);
  led.onwheel = e => { e.preventDefault(); set(box.value - Math.sign(e.deltaY)); };
  led.onpointerdown = e => {
    led.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = box.value;
    led.onpointermove = e => set(v0 + (y0 - e.clientY) / 4);
  };
  led.onpointerup = () => { led.onpointermove = null; };
  set(val);
  return box;
}

// Replace range inputs with rotary knobs (the hidden input keeps the value, so other code reads it as before).
// Must run after every machine has been mounted
export function knobify() {
  document.querySelectorAll<HTMLInputElement>('input[type=range]:not(.fader)').forEach(inp => {
    const k = document.createElement('div'), min = +inp.min, max = +inp.max;
    k.className = 'knob'; k.tabIndex = 0; k.setAttribute('role', 'slider');
    k.setAttribute('aria-label', inp.name || inp.id);
    inp.hidden = true; inp.after(k);
    inp.addEventListener('input', () => set()); // follow programmatic changes (song automation)
    const set = (val?: number | string) => {
      if (val !== undefined) { inp.value = String(val); inp.dispatchEvent(new Event('input')); }
      k.style.setProperty('--a', ((+inp.value - min) / (max - min) * 270 - 135) + 'deg');
      k.setAttribute('aria-valuenow', inp.value);
    };
    k.onpointerdown = e => {
      k.setPointerCapture(e.pointerId);
      const y0 = e.clientY, v0 = +inp.value;
      k.onpointermove = e => set(v0 + (y0 - e.clientY) / 150 * (max - min));
    };
    k.onpointerup = () => { k.onpointermove = null; };
    k.ondblclick = () => set(inp.defaultValue);
    k.onkeydown = e => {
      const d = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 } as Record<string, number>)[e.key];
      if (d) { e.preventDefault(); set(+inp.value + d * (max - min) / 50); }
    };
    inp.addEventListener('input', () => set()); // redraw when code changes the value
    set();
  });
}
