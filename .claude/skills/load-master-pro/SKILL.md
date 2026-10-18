```markdown
# load-master-pro Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `load-master-pro` JavaScript codebase. It covers file naming, import/export styles, commit message habits, and testing patterns. While no explicit frameworks or automated workflows were detected, this guide will help you contribute code that fits seamlessly into the project.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `loadManager.js`, `dataLoader.js`

### Imports
- Use **relative import paths**.
  - Example:
    ```javascript
    import { fetchData } from './dataLoader.js';
    ```

### Exports
- Use **named exports** (not default).
  - Example:
    ```javascript
    // In dataLoader.js
    export function fetchData(url) { ... }
    ```

### Commit Messages
- Freeform style, no strict prefixes.
- Average message length is about 46 characters.
  - Example:  
    ```
    add data loader for remote sources
    ```

## Workflows

### Adding a New Module
**Trigger:** When you need to add a new feature or utility.
**Command:** `/add-module`

1. Create a new file using camelCase (e.g., `myFeature.js`).
2. Write your functions and export them using named exports.
    ```javascript
    export function myFeature() { ... }
    ```
3. Import your module where needed using a relative path.
    ```javascript
    import { myFeature } from './myFeature.js';
    ```
4. Write corresponding tests in a file named `myFeature.test.js`.

### Writing Tests
**Trigger:** When you add or update functionality.
**Command:** `/write-test`

1. Create a test file with the pattern `*.test.js` (e.g., `dataLoader.test.js`).
2. Write test cases for your functions.
    ```javascript
    // Example test (framework unknown)
    test('fetchData returns data', () => {
      // test implementation
    });
    ```
3. Run your tests using the project's test runner (check project docs for details).

## Testing Patterns

- Test files use the `*.test.js` naming convention.
- Testing framework is **unknown**; check existing test files for syntax.
- Place tests alongside or near the module they test.
- Example test file:
    ```javascript
    // dataLoader.test.js
    import { fetchData } from './dataLoader.js';

    test('fetchData returns expected result', () => {
      // Your test logic here
    });
    ```

## Commands
| Command        | Purpose                                  |
|----------------|------------------------------------------|
| /add-module    | Scaffold and add a new module            |
| /write-test    | Create and write tests for a module      |
```
