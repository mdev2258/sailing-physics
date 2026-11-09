import { LAYERS, keyLabel, saveLayers, type LayerId, type LayerState } from '../render/layers';

/**
 * The layer switchboard: one chip per layer, grouped the way you'd think about them
 * (flow, pressure, forces, geometry). Click or use the key on the chip. The line underneath says
 * what the layer you're pointing at is actually showing.
 */
export class LayersPanel {
  el: HTMLElement;
  private chips = new Map<LayerId, HTMLButtonElement>();
  private hint: HTMLElement;
  private readonly idle = '';

  constructor(parent: HTMLElement, private state: LayerState, private onChange: (id: LayerId | null) => void) {
    this.el = document.createElement('div');
    this.el.id = 'layers';
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', 'Layers');
    const fold = document.createElement('button');
    fold.className = 'ly-fold';
    fold.id = 'layers-fold';
    fold.type = 'button';
    fold.textContent = 'Layers';
    fold.setAttribute('aria-expanded', 'true');
    fold.addEventListener('click', () => {
      const closed = this.el.classList.toggle('closed');
      fold.setAttribute('aria-expanded', String(!closed));
    });
    this.el.appendChild(fold);
    const body = document.createElement('div');
    body.className = 'ly-body';
    const groups = [...new Set(LAYERS.map((l) => l.group))];
    for (const g of groups) {
      const row = document.createElement('div');
      row.className = 'ly-group';
      const lab = document.createElement('span');
      lab.className = 'ly-gl';
      lab.textContent = g;
      row.appendChild(lab);
      for (const l of LAYERS.filter((x) => x.group === g)) {
        const bt = document.createElement('button');
        bt.type = 'button';
        bt.className = 'ly-chip';
        bt.id = `layer-${l.id}`;
        bt.setAttribute('aria-pressed', 'false');
        bt.innerHTML = `<i style="background:${l.color}"></i><span>${l.label}</span>${l.key ? `<kbd>${keyLabel(l.key)}</kbd>` : ''}`;
        bt.addEventListener('click', () => this.toggle(l.id));
        const show = () => { this.hint.textContent = `${l.label}: ${l.hint}`; };
        bt.addEventListener('pointerenter', show);
        bt.addEventListener('focus', show);
        bt.addEventListener('pointerleave', () => { this.hint.textContent = this.idle; });
        row.appendChild(bt);
        this.chips.set(l.id, bt);
      }
      body.appendChild(row);
    }
    const tools = document.createElement('div');
    tools.className = 'ly-group ly-tools';
    const mk = (id: string, text: string, fn: () => void) => {
      const bt = document.createElement('button');
      bt.type = 'button'; bt.className = 'ly-chip ly-plain'; bt.id = id; bt.textContent = text;
      bt.addEventListener('click', fn);
      tools.appendChild(bt);
    };
    mk('layers-none', 'All off', () => this.setAll(() => false));
    mk('layers-all', 'All on', () => this.setAll(() => true));
    mk('layers-reset', 'Default', () => this.setAll((id) => LAYERS.find((l) => l.id === id)!.on));
    body.appendChild(tools);
    this.hint = document.createElement('div');
    this.hint.className = 'ly-hint';
    this.hint.textContent = this.idle;
    body.appendChild(this.hint);
    this.el.appendChild(body);
    parent.appendChild(this.el);
    if (window.innerWidth < 900) { this.el.classList.add('closed'); fold.setAttribute('aria-expanded', 'false'); }
    this.sync();
  }

  toggle(id: LayerId) { this.set(id, !this.state[id]); }

  set(id: LayerId, on: boolean) {
    this.state[id] = on;
    this.sync();
    saveLayers(this.state);
    this.onChange(id);
  }

  private setAll(f: (id: LayerId) => boolean) {
    for (const l of LAYERS) this.state[l.id] = f(l.id);
    this.sync();
    saveLayers(this.state);
    this.onChange(null);
  }

  /** Reflect the state on the chips (call after changing it from outside). */
  sync() {
    for (const [id, bt] of this.chips) {
      bt.classList.toggle('on', this.state[id]);
      bt.setAttribute('aria-pressed', String(this.state[id]));
    }
  }
}
