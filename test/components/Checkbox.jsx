import React from 'react';
import { createField } from '../../lib';

function Checkbox({ fieldProps }) {
  return (<input { ...fieldProps } />);
}

Checkbox.displayName = 'Checkbox';

export default createField({
  valuePropName: 'checked',
  mapPropsToField: ({ props: { checked }, fieldRecord }) => ({
    ...fieldRecord,
    type: 'checkbox',
    initialValue: checked
  }),
  enforceProps: (props, contextProps) => ({
    checked: contextProps.get('checked')
  })
})(Checkbox);