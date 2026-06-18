import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AntennaNotice from './AntennaNotice';
import type { AntennaMeta } from '../types';

const baseMeta: AntennaMeta = {
    constraint_line_name: 'LINE_X',
    root_sub_name: 'SUB_ROOT',
    antenna_sub_names: ['S1', 'S2', 'S3'],
    n_subs: 3,
    total_prod_mw: 0,
    total_load_mw: 60,
    net_mw: -60,
    direction: 'consumer',
};

describe('AntennaNotice', () => {
    it('names the constraint line, the root and the pocket size', () => {
        render(<AntennaNotice meta={baseMeta} />);
        const notice = screen.getByTestId('antenna-notice');
        expect(notice).toHaveTextContent('LINE_X');
        expect(notice).toHaveTextContent('SUB_ROOT');
        expect(notice).toHaveTextContent('3');
        expect(notice).toHaveTextContent('S1, S2, S3');
    });

    it('describes a consumer pocket as load shedding / redispatch-up', () => {
        render(<AntennaNotice meta={baseMeta} />);
        expect(screen.getByTestId('antenna-notice')).toHaveTextContent(/load shedding/i);
    });

    it('describes a producer pocket as curtailment / redispatch-down', () => {
        render(<AntennaNotice meta={{ ...baseMeta, direction: 'producer', net_mw: 140 }} />);
        expect(screen.getByTestId('antenna-notice')).toHaveTextContent(/curtailment/i);
    });

    it('truncates a long pocket list with a "+N more" suffix', () => {
        const many = Array.from({ length: 10 }, (_, i) => `Sub${i}`);
        render(<AntennaNotice meta={{ ...baseMeta, antenna_sub_names: many, n_subs: 10 }} />);
        expect(screen.getByTestId('antenna-notice')).toHaveTextContent('+4 more');
    });
});
