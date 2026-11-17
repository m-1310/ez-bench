import path from 'node:path';
import { rcedit } from 'rcedit';
const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) throw new Error('Pass the absolute path of the newly built executable.');
const { version } = JSON.parse((await import('node:fs')).readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8'));
await rcedit(executable, { icon: path.join(import.meta.dirname, 'icon.ico'), 'file-version': version, 'product-version': version, 'version-string': { ProductName: 'EZ Bench', FileDescription: 'EZ Bench - Local SQL Workspace', InternalName: 'EZBench', OriginalFilename: 'EZ Bench.exe', CompanyName: 'EZ Bench', LegalCopyright: 'Copyright 2026 EZ Bench contributors' } });
