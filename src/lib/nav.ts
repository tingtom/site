export type SectionId = 'personal' | 'rx7' | 'landing';

export interface NavItem {
  label: string;
  href: string;
}

export interface Section {
  id: Exclude<SectionId, 'landing'>;
  label: string;
  href: string;
  lede: string;
  nav: NavItem[];
}

export const SECTIONS: Record<'personal' | 'rx7', Section> = {
  personal: {
    id: 'personal',
    label: 'Personal',
    href: '/personal/',
    lede: "Blog posts and projects I'm working on — mostly Source engine, servers and whatever else I've got half-built.",
    nav: [
      { label: 'Home', href: '/personal/' },
      { label: 'Blog', href: '/personal/blog/' },
      { label: 'Projects', href: '/personal/projects/' },
    ],
  },
  rx7: {
    id: 'rx7',
    label: 'RX7',
    href: '/rx7/',
    lede: 'FD3S wiring diagrams, 3D printed models and notes from a restoration that turned out to be everything.',
    nav: [
      { label: 'Home', href: '/rx7/' },
      { label: 'Blog', href: '/rx7/blog/' },
      { label: 'Diagrams', href: '/rx7/diagrams/' },
      { label: 'Models', href: '/rx7/models/' },
    ],
  },
};

export const SITE_NAME = 'tingtom';
