#!/usr/bin/env node
import { version } from './version.js';

// The git remote helper protocol arrives with ticket 09. This binary must not
// read stdin yet: git only spawns it for docsync:: remotes, which do not exist
// until then.
process.stdout.write(`${version}\n`);
process.exit(0);
