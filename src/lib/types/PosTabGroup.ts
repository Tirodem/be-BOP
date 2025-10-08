export interface PosTab {
	label?: string;
	color?: string;
}

export interface PosTabGroup {
	name: string;
	tabs: PosTab[];
}

export function defaultPosTabGroups(): PosTabGroup[] {
	return [
		{
			name: 'Tables',
			tabs: Array.from({ length: 5 }, () => ({}))
		},
		{
			name: 'Terrasse',
			tabs: [{ label: 'Sunny' }, { color: '#f59e0b' }]
		}
	];
}

export function sluggifyTab(
	posTabGroups: PosTabGroup[],
	groupIndex: number,
	tabIndex: number
): string {
	return `${posTabGroups[groupIndex].name}-${tabIndex}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}
