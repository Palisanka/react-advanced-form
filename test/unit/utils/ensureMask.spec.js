import { ensureMask } from '../../../src/utils';

describe('ensureMask', function () {
  it ('Formats the provided value using the given mask', () => {
    /* String and mask equal length */
    expect(ensureMask('abcdefg', '## ### ##')).to.equal('ab cde fg');

    /* String shorter than the mask */
    expect(ensureMask('1234567890', '#### #### #### ####')).to.equal('1234 5678 90');

    /* String longer than the mask */
    expect(ensureMask('1234567890', '## ## ##')).to.equal('12 34 567890');

    /* String with non-linear character indexes */
    expect(ensureMask('12 34567 89', '### ### ###')).to.equal('123 456 789');

    /* Mask with pre-defined characters */
    expect(ensureMask('1 234 5 6 789', '+(###) ### ### ###')).to.equal('+(123) 456 789');
  });
});
