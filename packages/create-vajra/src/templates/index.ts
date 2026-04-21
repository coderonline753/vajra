/**
 * Project templates for vajra new.
 */

import { minimalTemplate } from './minimal';
import { fullTemplate } from './full';

const TEMPLATES: Record<string, (name: string) => Record<string, string>> = {
  minimal: minimalTemplate,
  full: fullTemplate,
};

export function getTemplate(name: string, projectName: string): Record<string, string> {
  const template = TEMPLATES[name];
  if (!template) {
    console.error(`  Unknown template: ${name}`);
    console.error(`  Available: ${Object.keys(TEMPLATES).join(', ')}\n`);
    process.exit(1);
  }
  return template(projectName);
}
