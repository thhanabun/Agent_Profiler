#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';
await tsImport('../src/cli.tsx', import.meta.url);
