import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://better.sh',
  integrations: [
    starlight({
      title: 'better',
      description: 'Universal Package Manager for every ecosystem',
      social: { github: 'https://github.com/nicepkg/better' },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Installation', link: '/getting-started/installation/' },
            { label: 'Quick Start', link: '/getting-started/quickstart/' },
          ],
        },
        {
          label: 'Migration Guides',
          items: [
            { label: 'From npm', link: '/migration/npm/' },
            { label: 'From pnpm', link: '/migration/pnpm/' },
            { label: 'From yarn', link: '/migration/yarn/' },
            { label: 'From pip/uv', link: '/migration/python/' },
            { label: 'From cargo', link: '/migration/cargo/' },
          ],
        },
        { label: 'Commands', autogenerate: { directory: 'commands' } },
        { label: 'Configuration', autogenerate: { directory: 'config' } },
        { label: 'Ecosystems', autogenerate: { directory: 'ecosystems' } },
        { label: 'OSP Integration', autogenerate: { directory: 'osp' } },
        { label: 'JSON API Reference', link: '/api/json-schema/' },
      ],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
