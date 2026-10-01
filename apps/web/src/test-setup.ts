import '@testing-library/jest-dom/vitest';

// jsdom's createObjectURL rejects the Node Blob that tests construct.
URL.createObjectURL = () => 'blob:test';
URL.revokeObjectURL = () => {};
