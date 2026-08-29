import { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'hast-util-sanitize'

/** react-markdown 消毒 schema：在默认基础上放行表格标签 */
export const markdownSchema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  attributes: {
    ...defaultSchema.attributes,
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
  },
}
