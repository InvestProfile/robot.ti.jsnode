import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

type ImportReference = { specifier?: string; computed?: string };
type BoundaryViolation = {
    kind: 'forbidden-gateway' | 'computed-import' | 'unresolved-local-import';
    chain: string[];
};

const LAB_NAMESPACES = ['paper', 'virtual'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const FORBIDDEN_GATEWAY_FILES = [
    'app/services/orders.service.ts',
    'app/services/get-sdk.ts',
    'app/services/protective-stop.service.ts'
];
const FORBIDDEN_PACKAGES = ['tinkoff-sdk-grpc-js'];
const temporaryProjects: string[] = [];
const normalized = (value: string) => path.resolve(value).replace(/\\/g, '/');

const isInside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const listSourceFiles = (directory: string): string[] => {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        throw new Error(`Required Paper/Margin Lab namespace is missing: ${directory}`);
    }

    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listSourceFiles(entryPath);
        if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [normalized(entryPath)];
        return [];
    });
};

const readStaticString = (node: ts.Expression | undefined) =>
    node && ts.isStringLiteralLike(node) ? node.text : undefined;

const collectImports = (file: string): ImportReference[] => {
    const sourceText = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const imports: ImportReference[] = [];

    const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            const specifier = readStaticString(node.moduleSpecifier);
            imports.push(specifier ? { specifier } : { computed: node.moduleSpecifier.getText(source) });
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            const specifier = readStaticString(node.moduleReference.expression);
            imports.push(specifier ? { specifier } : { computed: node.moduleReference.getText(source) });
        } else if (ts.isCallExpression(node)) {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            if (isRequire || isDynamicImport) {
                const specifier = node.arguments.length === 1 ? readStaticString(node.arguments[0]) : undefined;
                imports.push(specifier ? { specifier } : { computed: node.getText(source) });
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(source);
    return imports;
};

const resolveProjectRoot = (cwd: string) => {
    const root = normalized(cwd);
    const packagePath = path.join(root, 'package.json');
    const tsconfigPath = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(packagePath) || !fs.existsSync(tsconfigPath)) {
        throw new Error(`Paper/Margin Lab boundary test must run from the repository root: ${root}`);
    }

    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: string };
    if (packageJson.name !== 'robot.ti.jsnode') {
        throw new Error(`Unexpected repository for Paper/Margin Lab boundary test: ${root}`);
    }
    return root;
};

const loadCompilerOptions = (projectRoot: string): ts.CompilerOptions => {
    const configPath = path.join(projectRoot, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    return ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot).options;
};

const analyzeBoundary = (projectRoot: string): { roots: string[]; violations: BoundaryViolation[] } => {
    const appRoot = normalized(path.join(projectRoot, 'app'));
    const roots = LAB_NAMESPACES.flatMap(namespace => listSourceFiles(path.join(appRoot, namespace)));
    const compilerOptions = loadCompilerOptions(projectRoot);
    const forbiddenFiles = new Set(FORBIDDEN_GATEWAY_FILES.map(file => normalized(path.join(projectRoot, file))));
    const violations: BoundaryViolation[] = [];

    const walk = (file: string, chain: string[], active: Set<string>) => {
        if (active.has(file)) return;
        const nextActive = new Set(active).add(file);

        for (const reference of collectImports(file)) {
            if (reference.computed) {
                violations.push({ kind: 'computed-import', chain: [...chain, `${file} -> ${reference.computed}`] });
                continue;
            }

            const specifier = reference.specifier as string;
            if (FORBIDDEN_PACKAGES.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
                violations.push({ kind: 'forbidden-gateway', chain: [...chain, `${file} -> ${specifier}`] });
                continue;
            }

            const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule;
            if (!resolved) {
                if (specifier.startsWith('.')) {
                    violations.push({ kind: 'unresolved-local-import', chain: [...chain, `${file} -> ${specifier}`] });
                }
                continue;
            }

            const resolvedFile = normalized(resolved.resolvedFileName);
            if (forbiddenFiles.has(resolvedFile)) {
                violations.push({ kind: 'forbidden-gateway', chain: [...chain, file, resolvedFile] });
                continue;
            }
            if (isInside(appRoot, resolvedFile) && !resolvedFile.endsWith('.d.ts')) {
                walk(resolvedFile, [...chain, file], nextActive);
            }
        }
    };

    for (const root of roots) walk(root, [], new Set());
    return { roots, violations };
};

const displayViolation = (projectRoot: string, violation: BoundaryViolation) =>
    `${violation.kind}: ${violation.chain.map(item => item.replace(normalized(projectRoot) + '/', '')).join(' -> ')}`;

const createFixtureProject = (files: Record<string, string>) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-boundary-'));
    temporaryProjects.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'app/paper'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'app/virtual'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'robot.ti.jsnode' }));
    fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'commonjs' } }));
    fs.writeFileSync(path.join(projectRoot, 'app/paper/index.ts'), 'export const paper = true;');
    fs.writeFileSync(path.join(projectRoot, 'app/virtual/index.ts'), 'export const virtual = true;');

    for (const [relativePath, source] of Object.entries(files)) {
        const file = path.join(projectRoot, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
    }
    return projectRoot;
};

afterEach(() => {
    while (temporaryProjects.length > 0) {
        fs.rmSync(temporaryProjects.pop() as string, { recursive: true, force: true });
    }
});

describe('Paper/Margin Lab architecture boundary', () => {
    it('has real roots and no path to a live broker order gateway', () => {
        const projectRoot = resolveProjectRoot(process.cwd());
        const result = analyzeBoundary(projectRoot);
        const relativeRoots = result.roots.map(file => path.relative(projectRoot, file));
        assert(relativeRoots.includes('app/paper/index.ts'), 'app/paper/index.ts must be a scanned root');
        assert(relativeRoots.includes('app/virtual/index.ts'), 'app/virtual/index.ts must be a scanned root');
        assert.deepEqual(result.violations, [], result.violations.map(item => displayViolation(projectRoot, item)).join('\n'));
    });

    it('reports a direct forbidden import with its chain', () => {
        const projectRoot = createFixtureProject({
            'app/paper/index.ts': "import '../services/orders.service';",
            'app/services/orders.service.ts': 'export default class OrdersService {}'
        });
        const result = analyzeBoundary(projectRoot);
        assert.equal(result.violations.length, 1);
        assert.match(displayViolation(projectRoot, result.violations[0]), /paper\/index\.ts.*orders\.service\.ts/);
    });

    it('reports a transitive forbidden import with the complete chain', () => {
        const projectRoot = createFixtureProject({
            'app/paper/index.ts': "import '../shared/decision';",
            'app/shared/decision.ts': "import '../services/get-sdk';",
            'app/services/get-sdk.ts': 'export const getSdk = () => undefined;'
        });
        const result = analyzeBoundary(projectRoot);
        const message = displayViolation(projectRoot, result.violations[0]);
        assert.equal(result.violations.length, 1);
        assert.match(message, /paper\/index\.ts.*shared\/decision\.ts.*services\/get-sdk\.ts/);
    });

    it('rejects computed require and dynamic import in the reachable graph', () => {
        const projectRoot = createFixtureProject({
            'app/virtual/index.ts': "import '../shared/loader';",
            'app/shared/loader.ts': "const target = '../services/orders.service'; require(target); import(target);"
        });
        const result = analyzeBoundary(projectRoot);
        assert.equal(result.violations.length, 2);
        assert(result.violations.every(item => item.kind === 'computed-import'));
        assert(result.violations.every(item => displayViolation(projectRoot, item).includes('shared/loader.ts')));
    });

    it('fails explicitly when started outside the repository root', () => {
        const wrongCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-boundary-cwd-'));
        temporaryProjects.push(wrongCwd);
        assert.throws(() => resolveProjectRoot(wrongCwd), /must run from the repository root/);
    });
});
