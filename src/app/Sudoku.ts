import { Notification } from '../utils/Notification';
import { Cell, DEFAULT_CELL_VALUE } from './Cell';
import { ByKnownCellsStrategy } from './strategy/ByKnownCellsStrategy';
import { BySinglePossibleValueStrategy } from './strategy/BySinglePossibleValueStrategy';
import { BySquareIntersectionStrategy } from './strategy/BySquareIntersectionStrategy';
import { ByValuesRangeStrategy } from './strategy/ByValuesRangeStrategy';
import { SolveStrategy } from './strategy/SolveStrategy';

interface Suggestion {
    snapshot: Sudoku;
    row: number;
    col: number;
    number: number;
}

export interface Sudoku {
    solve: (onCellUpdated: () => Promise<void>) => Promise<void>;
    stop: () => void;
    pause: () => void;
    isRunning: () => boolean;
    isPaused: () => boolean;
    continue: () => void;
    getCells: () => Cell[][];
    getCell: (rowIndex: number, cellIndex: number) => Cell;
    validate: () => void;
    isValid: () => boolean;
    clone: () => Sudoku;
    setTimeoutMs: (millis: number) => void;
    getTimeoutMs: () => number;
}

export class ClassicSudoku implements Sudoku {
    private spec = { length: 9 };
    private timeoutMs: number = 0;
    private cells: Cell[][];
    private strategies: SolveStrategy[] = [
        new ByKnownCellsStrategy(),
        new BySinglePossibleValueStrategy(),
        new ByValuesRangeStrategy(),
    ];
    private running = false;
    private paused = false;
    private suggestions: Suggestion[] = [];

    constructor() {
        this.cells = this.emptyField();
    }

    public stop = (): void => {
        this.running = false;
    };

    public pause = (): void => {
        this.paused = true;
    };

    public continue = (): void => {
        this.paused = false;
    };

    public isRunning = (): boolean => this.running;

    public isPaused = (): boolean => this.paused;

    public solve = (onCellUpdated: () => Promise<void>): Promise<void> => {
        return new Promise<void>(async (resolve) => {
            this.running = true;
            this.validate();
            if (!this.isValid()) {
                Notification.error('Sudoku field data is not valid');
                return;
            }
            await this.solveAsPossible(onCellUpdated);
            this.validate();
            await onCellUpdated();
            if (this.solved()) {
                Notification.info('Sudoku solved!');
            } else if (!this.isValid()) {
                Notification.error('There are some mistakes');
            } else {
                Notification.warn("Couldn't solve this sudoku");
            }

            this.running = false;
            resolve();
        });
    };

    private solveAsPossible = async (onCellUpdated: () => Promise<void>): Promise<void> => {
        let hasChanges = false;
        do {
            hasChanges = false;
            const columns = this.getColumns();
            for (let rowIndex = 0; rowIndex < this.spec.length; rowIndex++) {
                for (let columnIndex = 0; columnIndex < this.spec.length; columnIndex++) {
                    while (this.paused && this.running) {
                        await this.sleep(1000);
                    }
                    if (!this.running) {
                        break;
                    }
                    const cell = this.cells[rowIndex][columnIndex];
                    if (cell.hasValue()) {
                        continue;
                    }
                    if (cell.getPossibleValues().length === 1) {
                        const cellValue = cell.getPossibleValues()[0];
                        cell.fill(cellValue);
                        await onCellUpdated();
                        hasChanges = true;
                    }
                    const row = this.cells[rowIndex];
                    const column = columns[columnIndex];
                    const square = this.getSquare(rowIndex, columnIndex).flatMap((cell) => cell);
                    const cellUpdated = this.strategies
                        .map((strategy) => strategy.solve(cell, row, column, square))
                        .some((cellUpdated) => cellUpdated);
                    if (cell.hasValue()) {
                        this.removeFromPossibleValues(onCellUpdated, cell.getValue(), row);
                        this.removeFromPossibleValues(onCellUpdated, cell.getValue(), column);
                        this.removeFromPossibleValues(onCellUpdated, cell.getValue(), square);
                    }
                    if (cellUpdated) {
                        await onCellUpdated();
                        await this.sleep(this.timeoutMs);
                    }
                    hasChanges = hasChanges || cellUpdated;
                }
            }
            if (!hasChanges && !this.solved()) {
                for (let rowIndex = 0; rowIndex < this.spec.length; rowIndex++) {
                    for (let columnIndex = 0; columnIndex < this.spec.length; columnIndex++) {
                        const strategy = new BySquareIntersectionStrategy();
                        const cell = this.cells[rowIndex][columnIndex];
                        if (cell.hasValue()) {
                            continue;
                        }
                        const row = this.cells[rowIndex];
                        const column = columns[columnIndex];
                        const square = this.getSquare(rowIndex, columnIndex).flatMap((cell) => cell);
                        const cellUpdated = strategy.solve(cell, row, column, square);
                        if (cellUpdated) {
                            await onCellUpdated();
                            await this.sleep(this.timeoutMs);
                        }
                        hasChanges = hasChanges || cellUpdated;
                    }
                }
            }
            if (!hasChanges && !this.solved()) {
                const suggestionCandidate = this.cells
                    .flatMap((c) => c)
                    .filter((c) => !c.hasValue())
                    .reduce((a, b) => (a.getPossibleValues().length < b.getPossibleValues().length ? a : b));
                const suggestion = suggestionCandidate.getPossibleValues()[0];
                const row = suggestionCandidate.getRowIndex();
                const col = suggestionCandidate.getColumnIndex();

                Notification.info(`Suggest that cell [${row}:${col}] has value ${suggestion}`);
                this.suggestions.push({
                    snapshot: this.clone(),
                    row: row,
                    col: col,
                    number: suggestion,
                });
                suggestionCandidate.fill(suggestion);
                await onCellUpdated();
                hasChanges = true;
            }
            if (this.suggestions.length > 0) {
                this.validate();
                if (!this.isValid()) {
                    Notification.info('Restore field from last snapshot');
                    const suggestion = this.suggestions.pop();
                    const snapshot = suggestion!.snapshot;
                    const suggestedNumber = suggestion!.number;
                    this.cells = snapshot.getCells();
                    const cell = this.getCell(suggestion!.row, suggestion!.col);
                    const possibleValues = cell.getPossibleValues().filter((v) => v !== suggestedNumber);
                    cell.setPossibleValues(possibleValues);
                    await onCellUpdated();
                }
            }
        } while (this.running && !this.solved() && hasChanges);
    };

    private removeFromPossibleValues = async (
        onCellUpdated: () => Promise<void>,
        value: number,
        range: Cell[]
    ): Promise<void> => {
        const cellsToCheck = range.filter((cell) => !cell.hasValue());
        for (let i = 0; i < cellsToCheck.length; i++) {
            const cell = cellsToCheck[i];
            const possibleValues = cell.getPossibleValues();
            if (possibleValues.includes(value)) {
                const filtered = possibleValues.filter((v) => v !== value);
                filtered.length === 1 ? cell.fill(filtered[0]) : cell.setPossibleValues(filtered);
                await onCellUpdated();
                await this.sleep(this.timeoutMs);
            }
        }
    };

    private sleep = (timeoutMs: number): Promise<void> => {
        return new Promise((resolve) => setTimeout(resolve, timeoutMs));
    };

    public setTimeoutMs = (millis: number): void => {
        this.timeoutMs = millis;
    };

    public getTimeoutMs = (): number => {
        return this.timeoutMs;
    };

    public getCells = (): Cell[][] => {
        return this.cells;
    };

    public getCell = (rowIndex: number, cellIndex: number): Cell => {
        return this.cells[rowIndex][cellIndex];
    };

    public validate = (): void => {
        this.cells.forEach((row) => row.forEach((cell) => cell.setIsValid(true)));
        const rows = this.cells;
        const columns = this.getColumns();
        const squares = this.getSquares();
        this.validateRanges(rows);
        this.validateRanges(columns);
        this.validateRanges(squares);
    };

    public isValid = (): boolean => {
        return this.cells.flatMap((v) => v).filter((cell) => !cell.isValid()).length === 0;
    };

    public clone = (): Sudoku => {
        const clone = new ClassicSudoku();
        this.cells.forEach((row, rowIndex) => {
            row.forEach((cell, cellIndex) => {
                const cellClone = clone.getCell(rowIndex, cellIndex);
                cellClone.setValue(cell.getValue());
                cellClone.setPossibleValues(cell.getPossibleValues());
            });
        });
        clone.timeoutMs = this.timeoutMs;
        return clone;
    };

    private validateRanges = (ranges: Cell[][]): void => {
        ranges.forEach((range) => {
            range.forEach((cell) => {
                if (cell.getValue() === DEFAULT_CELL_VALUE || !cell.isValid()) {
                    return;
                }
                const isValid = !this.isDuplicated(cell, range);
                cell.setIsValid(isValid);
            });
        });
    };

    private getColumns = (): Cell[][] => {
        const columns = new Array<Array<Cell>>();
        for (let i = 0; i < this.spec.length; i++) {
            const column = this.cells.map((row) => row[i]);
            columns.push(column);
        }
        return columns;
    };

    private getSquares = (): Cell[][] => {
        return [
            this.getSquare(0, 0).flatMap((r) => r),
            this.getSquare(0, 3).flatMap((r) => r),
            this.getSquare(0, 6).flatMap((r) => r),
            this.getSquare(3, 0).flatMap((r) => r),
            this.getSquare(3, 3).flatMap((r) => r),
            this.getSquare(3, 6).flatMap((r) => r),
            this.getSquare(6, 0).flatMap((r) => r),
            this.getSquare(6, 3).flatMap((r) => r),
            this.getSquare(6, 6).flatMap((r) => r),
        ];
    };

    private solved = (): boolean => {
        return this.cells.flatMap((c) => c).filter((c) => !c.hasValue()).length === 0;
    };

    private getSquare = (rowIndex: number, columnIndex: number): Cell[][] => {
        const rowRange = this.getSquareIndexes(rowIndex);
        const colRange = this.getSquareIndexes(columnIndex);
        const rows = this.cells.slice(rowRange.start, rowRange.end + 1);
        const square = rows.map((row) => row.slice(colRange.start, colRange.end + 1));
        return square;
    };

    private isDuplicated = (cell: Cell, cells: Cell[]): boolean => {
        return cells.filter((c) => c.getValue() === cell.getValue()).length > 1;
    };

    private getSquareIndexes = (index: number): { start: number; end: number } => {
        if ([0, 1, 2].includes(index)) {
            return { start: 0, end: 2 };
        }
        if ([3, 4, 5].includes(index)) {
            return { start: 3, end: 5 };
        }
        if ([6, 7, 8].includes(index)) {
            return { start: 6, end: 8 };
        }
        return { start: -1, end: -1 };
    };

    private emptyField = (): Cell[][] => {
        const field: Cell[][] = [];
        for (let rowIndex = 0; rowIndex < this.spec.length; rowIndex++) {
            const row: Cell[] = [];
            for (let columnIndex = 0; columnIndex < this.spec.length; columnIndex++) {
                const cell = new Cell(rowIndex, columnIndex);
                row.push(cell);
            }
            field.push(row);
        }
        return field;
    };
}
