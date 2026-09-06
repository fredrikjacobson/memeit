import { zodToJsonSchema } from 'zod-to-json-schema';
import { ProjectSchema } from './index.js';

/** JSON Schema (draft-07) for the Project format, for non-TS tools/agents. */
export const projectJsonSchema = zodToJsonSchema(ProjectSchema, 'Project');
