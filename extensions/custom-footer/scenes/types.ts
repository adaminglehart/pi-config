export interface Scene {
	name: string;
	height: number;
	render(width: number, contextPercent: number): string[];
	onCommand?(ctx: any): void;
}
