#!/usr/bin/env node
import { version } from './version.js';

// Argument parsing arrives with ticket 10. For now every invocation prints the
// version, so that an install can be smoke-tested end to end.
process.stdout.write(`${version}\n`);
process.exit(0);
