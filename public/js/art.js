// Иллюстрации товаров без фотографий: пачка кофе цвета своей обжарки
// и простые значки для посуды. В реальном магазине здесь будут фото из каталога.
const ROAST = {
  light: ['#c99b6b', 'светлая'],
  medium: ['#94643c', 'средняя'],
  'medium-dark': ['#6a452b', 'средне-тёмная'],
  dark: ['#3a2a20', 'тёмная'],
};

const stroke = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  drip: `<rect x="22" y="20" width="36" height="40" rx="3" ${stroke}/><path d="M22 30h36M30 20v-6h20v6" ${stroke}/><path d="M33 44c3-5 11-5 14 0" ${stroke}/>`,
  grinder: `<rect x="24" y="34" width="32" height="30" rx="4" ${stroke}/><path d="M28 34l4-12h16l4 12M40 22v-8M40 14h14" ${stroke}/><circle cx="54" cy="14" r="3" ${stroke}/>`,
  brewer: `<path d="M20 22h40l-12 22H32z" ${stroke}/><path d="M34 44v6h12v-6M26 62h28" ${stroke}/><path d="M28 56h24" ${stroke}/>`,
  kettle: `<path d="M24 34h30v24a4 4 0 0 1-4 4H28a4 4 0 0 1-4-4z" ${stroke}/><path d="M54 40l12-14M32 34v-6h14v6" ${stroke}/><path d="M24 40c-6 0-6 12 0 12" ${stroke}/>`,
  accessory: `<rect x="18" y="38" width="44" height="22" rx="4" ${stroke}/><rect x="30" y="44" width="20" height="8" rx="2" ${stroke}/><path d="M26 32h28" ${stroke}/>`,
  machine: `<rect x="20" y="16" width="40" height="46" rx="4" ${stroke}/><path d="M26 28h28M32 36h16v6H32zM36 50h8v6h-8z" ${stroke}/><path d="M20 62h40" ${stroke}/>`,
};

export function productArt(p) {
  if (p.category === 'beans') {
    const [color, label] = ROAST[p.roast] ?? ROAST.medium;
    return `<svg viewBox="0 0 80 80" width="84" height="84" role="img" aria-label="Пачка кофе, обжарка ${label}">
      <path d="M22 18h36l4 52a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z" fill="${color}"/>
      <path d="M22 18l-2-6h40l-2 6" fill="${color}" opacity=".8"/>
      <rect x="25" y="36" width="30" height="22" rx="3" fill="#f6f1e8"/>
      <ellipse cx="40" cy="47" rx="5" ry="7" transform="rotate(25 40 47)" fill="${color}"/>
      <path d="M38 41c2.5 2 0 6 3.5 11" fill="none" stroke="#f6f1e8" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 80 80" width="72" height="72" role="img" aria-label="${p.name}" style="color:var(--ink-2)">${ICONS[p.category] ?? ICONS.accessory}</svg>`;
}
