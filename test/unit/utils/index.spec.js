import { expect } from 'chai';
import { fromJS, Map } from 'immutable';
import { ensureMask, fieldUtils } from '../../../src/utils';

describe('utils', () => {
  /**
   * Common
   */
  describe('Common', () => {
    it ('ensureMask', () => {
      /* String and mask equal length */
      expect(ensureMask('abcdefg', '## ### ##')).to.equal('ab cde fg');
      expect(ensureMask('12061992', '## / ## / ####')).to.equal('12 / 06 / 1992');

      /* String shorter than the mask */
      expect(ensureMask('1234567890', '#### #### #### ####')).to.equal('1234 5678 90');

      /* String longer than the mask */
      expect(ensureMask('1234567890', '##-##-##')).to.equal('12-34-567890');

      /* String with non-linear character indexes */
      expect(ensureMask('12 34567 89', '### ### ###')).to.equal('123 456 789');

      /* Mask with pre-defined characters */
      expect(ensureMask('1 234 5 6 789', '+(###) ### ### ###')).to.equal('+(123) 456 789');
    });
  });

  /**
   * Field utils
   */
  describe('Field utils', () => {
    /**
     * getDynamicProps
     */
    it('getDynamicProps', () => {
      const fieldProps = {
        disabled: false,
        required: () => true
      };

      expect(fieldUtils.getDynamicProps(fieldProps).toJS()).to.have.all.keys(['required']);
    });

    /**
     * getErrorMessages
     */
    // require('./getErrorMessages.spec');

    /**
     * getFieldPath
     */
    it('getFieldPath', () => {
      const fieldOne = { name: 'fieldOne' };
      const fieldTwo = { fieldGroup: 'groupOne', name: 'fieldTwo' };

      expect(fieldUtils.getFieldPath(fieldOne)).to.eq('fieldOne');
      expect(fieldUtils.getFieldPath(fieldTwo)).to.eq('groupOne.fieldTwo');
    });

    /**
     * getFieldProps
     */
    it('getFieldProps', () => {
      const fields = fromJS({ fieldOne: { value: 'context' } });
      const fallbackProps = { value: 'fallback' };

      expect(fieldUtils.getFieldProps('fieldOne', fields, fallbackProps)).to.deep.eq(fields.get('fieldOne').toJS());
      expect(fieldUtils.getFieldProps('fieldTwo', fields, fallbackProps)).to.deep.eq(fallbackProps);
    });

    /**
     * getValidityState
     */
    it('getValidityState', () => {
      /* Invalid field */
      const fieldOne = Map({
        expected: false,
        value: 'foo',
        validatedSync: true,
        validatedAsync: true
      });

      /* Valid field */
      const fieldTwo = Map({
        expected: true,
        value: 'foo',
        validatedSync: true,
        validatedAsync: false
      });

      /* Not valid, neither invalid field */
      const fieldThree = Map({
        expected: true,
        value: '',
        validatedSync: true,
        validatedAsync: false
      });

      expect(fieldUtils.getValidityState(fieldOne).toJS()).to.deep.eq({ valid: false, invalid: true });
      expect(fieldUtils.getValidityState(fieldTwo).toJS()).to.deep.eq({ valid: true, invalid: false });
      expect(fieldUtils.getValidityState(fieldThree).toJS()).to.deep.eq({ valid: false, invalid: false });
    });

    /**
     * resolveProp
     */
    it('resolveProp', () => {
      const fieldOne = { disabled: true, value: 'foo' };
      const fieldTwo = { required: ({ fields }) => fields.fieldOne.disabled };
      const fields = fromJS({ fieldOne, fieldTwo });

      expect(fieldUtils.resolveProp({ propName: 'value', fieldProps: fieldOne })).to.equal('foo');
      expect(fieldUtils.resolveProp({ propName: 'required', fieldProps: fieldTwo, fields })).to.equal(true);
    });

    /**
     * serializeFields
     */
    require('./serializeFields.spec');

    /**
     * Synchronous validation.
     */
    require('./validateSync');
  });
});
