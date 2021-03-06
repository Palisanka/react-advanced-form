import invariant from 'invariant';
import React from 'react';
import PropTypes from 'prop-types';
import { EventEmitter } from 'events';
import { fromJS, List, Map } from 'immutable';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/operator/bufferTime';
import 'rxjs/add/observable/fromEvent';

/* Internal modules */
import { defaultDebounceTime, TValidationRules, TValidationMessages } from './FormProvider';
import { BothValidationType, SyncValidationType } from '../classes/ValidationType';
import {
  CustomPropTypes,
  isset,
  camelize,
  dispatch,
  flattenDeep,
  formUtils,
  fieldUtils,
  rxUtils
} from '../utils';

/**
 * Shorthand: Binds the component's reference to the function's context and calls an optional callback
 * function to access that reference.
 * @param {HTMLElement} element
 * @param {Function} callback
 */
function getInnerRef(element, callback) {
  this.innerRef = element;
  if (callback) callback(element);
}

function filterFields(entry) {
  return entry.has('fieldPath');
}

export default class Form extends React.Component {
  static propTypes = {
    /* General */
    innerRef: PropTypes.func, // reference to the <form> element
    action: PropTypes.func.isRequired, // form submit action

    /* Validation */
    rules: TValidationRules,
    messages: TValidationMessages,

    /* Events */
    onFirstChange: PropTypes.func,
    onReset: PropTypes.func,
    onInvalid: PropTypes.func,
    onSubmitStart: PropTypes.func, // form should submit, submit started
    onSubmitted: PropTypes.func, // form submit went successfully
    onSubmitFailed: PropTypes.func, // form submit failed
    onSubmitEnd: PropTypes.func // form has finished submit (regardless of the result)
  }

  static defaultProps = {
    action: () => new Promise(resolve => resolve())
  }

  state = {
    fields: Map(),
    rxRules: Map(),
    dirty: false
  }

  /* Context which is accepted by Form */
  static contextTypes = {
    rules: CustomPropTypes.Map,
    messages: CustomPropTypes.Map,
    debounceTime: PropTypes.number,
    withImmutable: PropTypes.bool
  }

  /* Context which Form passes to Fields */
  static childContextTypes = {
    fields: CustomPropTypes.Map.isRequired,
    form: PropTypes.object.isRequired
  }

  getChildContext() {
    return {
      fields: this.state.fields,
      form: this
    };
  }

  constructor(props, context) {
    super(props, context);
    const { rules: explicitRules, messages: explicitMessages } = props;
    const { debounceTime, rules, messages } = context;

    /* Provide a fallback value for validation debounce duration */
    this.debounceTime = isset(debounceTime) ? debounceTime : defaultDebounceTime;

    /* Define validation rules */
    this.formRules = formUtils.mergeRules(explicitRules, rules);

    /**
     * Define validation messages once, since those should be converted to immutable, which is
     * an expensive procedure. Moreover, messages are unlikely to change during the component's
     * lifecycle. It should be safe to store them.
     * Note: Messages passed from FormProvider (context messages) are already immutable.
     */
    this.messages = explicitMessages ? fromJS(explicitMessages) : messages;

    /* Create a private event emitter to communicate between form and its fields */
    const eventEmitter = new EventEmitter();
    this.eventEmitter = eventEmitter;

    /* Field lifecycle observerables */
    Observable.fromEvent(eventEmitter, 'fieldRegister')
      .bufferTime(100)
      .subscribe(pendingFields => pendingFields.forEach(this.registerField));
    Observable.fromEvent(eventEmitter, 'fieldFocus').subscribe(this.handleFieldFocus);
    Observable.fromEvent(eventEmitter, 'fieldChange').subscribe(this.handleFieldChange);
    Observable.fromEvent(eventEmitter, 'fieldBlur').subscribe(this.handleFieldBlur);
    Observable.fromEvent(eventEmitter, 'fieldUnregister').subscribe(this.unregisterField);
    Observable.fromEvent(eventEmitter, 'validateField').subscribe(this.validateField);
  }

  /**
   * Maps the field to the state/context.
   * Passing fields in context gives a benefit of removing an explicit traversing of children
   * tree, deconstructing and constructing each appropriate child with the attached handler props.
   * @param {Map} fieldProps
   */
  registerField = ({ fieldProps: initialFieldProps, fieldOptions }) => {
    const { fields } = this.state;
    const fieldPath = initialFieldProps.get('fieldPath');
    const isAlreadyExist = fields.hasIn(fieldPath);

    console.groupCollapsed(fieldPath, '@ registerField');
    console.log('initialFieldProps', initialFieldProps.toJS());
    console.log('already exists:', isAlreadyExist);
    console.groupEnd();

    /* Warn on field duplicates */
    invariant(!(isAlreadyExist && !fieldOptions.allowMultiple), 'Cannot register field `%s`, the field with ' +
      'the provided name is already registered. Make sure the fields on the same level of `Form` ' +
      'or `Field.Group` have unique names.', fieldPath);

    /* Perform custom field props transformations upon registration */
    const fieldProps = fieldOptions.beforeRegister({
      fieldProps: initialFieldProps,
      fields
    });

    if (!fieldProps) {
      return;
    }

    const nextFields = fields.setIn(fieldPath, fieldProps);
    const { eventEmitter } = this;

    /**
     * Synchronize the field record with the field props.
     * Create a props change observer to keep field's record in sync with the props changes
     * of the respective field component. Only the changes in the props relative to the record
     * should be observed and synchronized.
     */
    rxUtils.addPropsObserver({
      fieldPath,
      props: ['type'],
      eventEmitter
    }).subscribe(({ changedProps }) => {
      this.updateField({
        fieldPath,
        update: fieldProps => Object.keys(changedProps).reduce((acc, propName) => {
          return acc.set(propName, changedProps[propName]);
        }, fieldProps)
      });
    });

    /**
     * Analyze the rules relevant to the registered field and create reactive subscriptions to
     * resolve them once their dependencies update. Returns the Map of the recorded formatted rules.
     * That Map is later used during the sync validation as the rules source.
     */
    const nextRxRules = rxUtils.createRulesSubscriptions({
      fieldProps,
      fields,
      form: this
    });

    this.setState({ fields: nextFields, rxRules: nextRxRules }, () => {
      /* Emit the field registered event */
      const fieldRegisteredEvent = camelize(...fieldPath, 'registered');
      eventEmitter.emit(fieldRegisteredEvent, fieldProps);

      if (fieldOptions.shouldValidateOnMount) {
        this.validateField({
          fieldProps,

          /**
           * Enforce the validation function to use the "fieldProps" provided directly.
           * By default, it will try to grab the field record from the state, which is
           * missing at this point of execution.
           */
          forceProps: true
        });
      }

      /* Create subscriptions for reactive props */
      rxUtils.createSubscriptions({
        fieldProps,
        fields: nextFields,
        form: this
      });
    });
  }

  /**
   * Determines if the provided field has its record within the state.
   * @param {Map} fieldProps
   * @return {boolean}
   */
  hasField = (fieldProps) => {
    return this.state.fields.hasIn(fieldProps.get('fieldPath'));
  }

  /**
   * Updates the provided field using a pure "update" function.
   * Fields can be updated by their field paths, or by providing their field props explicitly.
   * The latter is useful for scenarios when the field props values are different than those
   * stored in form's state at the moment of dispatching field update (i.e. field validation).
   * @param {string[]} fieldPath
   * @param {Map} fieldProps
   * @param {Function} update
   * @returns {Promise}
   */
  updateField = ({ fieldPath: explicitFieldPath, fieldProps: explicitFieldProps, update }) => {
    invariant(update, 'Field update failed: expected an `update` function, but got: %s', update);
    invariant(explicitFieldPath || explicitFieldProps, 'Field update failed: expected `fieldPath` or `fieldProps` ' +
      'provided, but got: %s.', explicitFieldPath || explicitFieldProps);

    const { fields } = this.state;
    const fieldPath = explicitFieldProps ? explicitFieldProps.get('fieldPath') : explicitFieldPath;
    const fieldProps = explicitFieldProps || fields.getIn(fieldPath);
    const nextFieldProps = update(fieldProps);
    const nextFields = fields.setIn(fieldPath, nextFieldProps);

    console.groupCollapsed(fieldPath, '@ updateField');
    console.log('fieldProps:', Object.assign({}, fieldProps.toJS()));
    console.log('fields before update:', Object.assign({}, fields.toJS()));
    console.log('next fieldProps:', Object.assign({}, nextFieldProps.toJS()));
    console.log('next value:', nextFieldProps.get(nextFieldProps.get('valuePropName')));
    console.log('nextFields:', Object.assign({}, nextFields.toJS()));
    console.groupEnd();

    return new Promise((resolve, reject) => {
      try {
        this.setState({ fields: nextFields }, () => {
          resolve({ nextFieldProps, nextFields });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Deletes the field record from the state.
   * @param {Map} fieldProps
   */
  unregisterField = (fieldProps) => {
    this.setState(prevState => ({
      fields: prevState.fields.deleteIn(fieldProps.get('fieldPath'))
    }));
  }

  /**
   * Handles the first field change of the form.
   * @param {Event} event
   * @param {any} nextValue
   * @param {any} prevValue
   * @param {Map} fieldProps
   */
  handleFirstChange = ({ event, nextValue, prevValue, fieldProps }) => {
    const { onFirstChange } = this.props;
    if (!onFirstChange) return;

    dispatch(onFirstChange, {
      event,
      nextValue,
      prevValue,
      fieldProps,
      fields: this.state.fields,
      form: this
    }, this.context);

    this.setState({ dirty: true });
  }

  /**
   * Handles field focus.
   * @param {Event} event
   * @param {Map} fieldProps
   */
  handleFieldFocus = async ({ event, fieldProps }) => {
    /* Bypass events called from an unregistered Field */
    if (!this.hasField(fieldProps)) return;

    console.groupCollapsed(fieldProps.get('fieldPath'), '@ handleFieldFocus');
    console.log('fieldProps', Object.assign({}, fieldProps.toJS()));
    console.groupEnd();

    const { nextFieldProps, nextFields } = await this.updateField({
      fieldPath: fieldProps.get('fieldPath'),
      update: fieldProps => fieldProps.set('focused', true)
    });

    /* Call custom onFocus handler */
    const onFocusHandler = fieldProps.get('onFocus');
    if (!onFocusHandler) return;

    dispatch(onFocusHandler, {
      event,
      fieldProps: nextFieldProps,
      fields: nextFields,
      form: this
    }, this.context);
  }

  /**
   * Handles field change.
   * @param {Event} event
   * @param {Map} fieldProps
   * @param {mixed} prevValue
   * @param {mixed} nextValue
   */
  handleFieldChange = async ({ event, fieldProps, prevValue, nextValue }) => {
    /* Bypass events called from an unregistered Field */
    if (!this.hasField(fieldProps)) return;

    console.groupCollapsed(fieldProps.get('fieldPath'), '@ handleFieldChange');
    console.log('fieldProps', Object.assign({}, fieldProps.toJS()));
    console.log('nextValue', nextValue);
    console.groupEnd();

    /**
     * Handle "onChange" events dispatched by the controlled field.
     * Controlled field must execute its custom "CustomField.props.onChange" handler since that
     * is the updater for the source (i.e. state) controlling its value. Internal RAF change handling
     * must be omitted in that scenario, as it will be bubbled to eventually via
     * "createField.Field.componentReceiveProps()", when comparing previous and next values of
     * controlled fields.
     */
    const isForcedUpdate = event && !((event.nativeEvent || event).isForcedUpdate);
    const isControlled = fieldProps.get('controlled');
    const onChangeHandler = fieldProps.get('onChange');

    if (isForcedUpdate && isControlled) {
      invariant(onChangeHandler, 'Cannot update the controlled field `%s`. Expected custom `onChange` handler, ' +
      'but received: %s.', fieldProps.get('name'), onChangeHandler);

      return dispatch(onChangeHandler, {
        event,
        nextValue,
        prevValue,
        fieldProps,
        fields: this.state.fields,
        form: this
      }, this.context);
    }

    const valuePropName = fieldProps.get('valuePropName');

    const { nextFieldProps: updatedFieldProps } = await this.updateField({
      fieldPath: fieldProps.get('fieldPath'),
      update: fieldProps => fieldProps
        .set(valuePropName, nextValue)
        .set('validated', false)
        .set('validating', false)
        .set('validatedSync', false)
        .set('validSync', false)
        .set('validatedAsync', false)
        .set('validAsync', false)
        // .set('errors', null)
    });

    /* Cancel any pending async validation due to the field's value change */
    if (updatedFieldProps.has('pendingAsyncValidation')) {
      const cancelPendingValidation = updatedFieldProps.getIn(['pendingAsyncValidation', 'cancel']);
      cancelPendingValidation();
    }

    /**
     * Perform appropriate field validation on value change.
     * When field has a value set, perform debounced sync validation. For the cases
     * when the user clears the field instantly, perform instant sync validation.
     *
     * The presence of "value" alone is not enough to determine the necessity for debounced
     * validation. For instance, it is only when the previous and next value exist we can
     * assume that the user is typing in the field. Change from "undefined" to some value
     * most likely means the value update of the controlled field, which must be validated
     * instantly.
     */
    const shouldDebounce = !!prevValue && !!nextValue;
    const appropriateValidation = shouldDebounce ? fieldProps.get('debounceValidate') : this.validateField;

    const { nextFields, nextFieldProps: validatedFieldProps } = await appropriateValidation({
      type: SyncValidationType,
      fieldProps: updatedFieldProps,
      forceProps: !shouldDebounce
    });

    /**
     * Call custom "onChange" handler for uncontrolled fields only.
     * "onChange" callback method acts as an updated function for controlled fields, and as a callback
     * function for uncontrolled fields. The value update of uncontrolled fields is handled by the Form.
     * Controlled fields dispatch "onChange" handler at the beginning of this method.
     * There is no need to dispatch the handler method once more.
     */
    if (!isControlled && onChangeHandler) {
      dispatch(onChangeHandler, {
        event,
        nextValue,
        prevValue,
        fieldProps: validatedFieldProps,
        fields: nextFields,
        form: this
      }, this.context);
    }

    /* Mark form as dirty if it's not already */
    if (!this.state.dirty) {
      this.handleFirstChange({ event, nextValue, prevValue, fieldProps });
    }
  }

  /**
   * Handles field blur.
   * @param {Event} event
   * @param {Map} fieldProps
   */
  handleFieldBlur = async ({ event, fieldProps }) => {
    /* Bypass events called from an unregistered Field */
    if (!this.hasField(fieldProps)) return;

    const fieldPath = fieldProps.get('fieldPath');
    const asyncRule = fieldProps.get('asyncRule');
    const validSync = fieldProps.get('validSync');
    const validatedSync = fieldProps.get('validatedSync');
    const validatedAsync = fieldProps.get('validatedAsync');

    /**
     * Determine whether the validation is needed.
     * Also, determine a type of the validation. In case the field has been validated sync
     * and is valid sync, it's ready to be validated async (if any async validation is present).
     * However, if the field hasn't been validated sync yet (hasn't been touched), first require
     * sync validation. When the latter fails, user will be prompted to change the value of the
     * field. Changing the value resets the "async" validation state as well. Hence, when the
     * user will pass sync validation, upon blurring out the field, the validation type will
     * be "async".
     */
    //
    //
    // TODO Review if this is really needed. Why not just "ValidationType.shouldValidate()"?
    //
    //
    const shouldValidate = !validatedSync || (validSync && !validatedAsync && asyncRule);

    console.groupCollapsed(fieldProps.get('fieldPath'), '@ handleFieldBlur');
    console.log('fieldProps', Object.assign({}, fieldProps.toJS()));
    console.log('should validate', shouldValidate);
    console.groupEnd();

    if (shouldValidate) {
      /* Indicate that the validation is running */
      const { nextFieldProps } = await this.updateField({
        fieldPath,
        update: fieldProps => fieldProps
          .set('errors', null)
          .set('invalid', false)
          .set('validating', true)
      });

      /* Validate the field */
      await this.validateField({ fieldProps: nextFieldProps });
    }

    /* Make field enabled, update its props */
    const { nextFields, nextFieldProps } = await this.updateField({
      fieldPath,
      update: fieldProps => fieldProps
        .set('focused', false)
        .set('validating', false)
    });

    /* Call custom onBlur handler */
    const onBlur = nextFieldProps.get('onBlur');
    if (!onBlur) return;

    dispatch(onBlur, {
      event,
      fieldProps: nextFieldProps,
      fields: nextFields,
      form: this
    }, this.context);
  }

  /**
   * Validates the provided field.
   * @param {Map} fieldProps
   * @param {ValidationType} type
   * @param {boolean} forceProps (Optional) Use the field props from the arguments instead of form's state.
   * @param {Map} fields (Optional) Explicit fields state to prevent validation concurrency.
   * @param {boolean} force (Optional) Force validation. Bypass "shouldValidate" logic.
   */
  validateField = async ({
    type = BothValidationType,
    fieldProps: explicitFieldProps,
    fields: explicitFields,
    forceProps = false,
    force = false
  }) => {
    const { formRules } = this;
    const fields = explicitFields || this.state.fields;

    let fieldProps = forceProps ? explicitFieldProps : fields.getIn(explicitFieldProps.get('fieldPath'));
    fieldProps = fieldProps || explicitFieldProps;

    /* Bypass the validation if the provided validation type has been already validated */
    const needsValidation = type.shouldValidate({
      validationType: type,
      fieldProps,
      formRules
    });

    const shouldValidate = force || needsValidation;

    console.groupCollapsed(fieldProps.get('fieldPath'), '@ validateField');
    console.log('validation type', type);
    console.log('value', fieldProps.get(fieldProps.get('valuePropName')));
    console.log('fieldProps', Object.assign({}, fieldProps.toJS()));
    console.log('shouldValidate', shouldValidate);
    console.groupEnd();

    /* Bypass the validation when none is needed */
    if (!shouldValidate) {
      return {
        nextFieldProps: fieldProps,
        nextFields: fields
      };
    }

    /* Perform the validation */
    const validationResult = await fieldUtils.validate({
      type,
      fieldProps,
      fields,
      form: this,
      formRules
    });

    /* Update the validity state (valid/invalid) of the field */
    let propsPatch = validationResult.get('propsPatch');
    const expected = propsPatch.get('expected');

    /* Determine if there are any messages available to form */
    const { messages } = this;
    const hasMessages = messages && (messages.size > 0);

    /* Get the validation messages based on the validation result */
    if (hasMessages && !expected) {
      const errorMessages = fieldUtils.getErrorMessages({
        validationResult,
        messages,
        fieldProps,
        fields,
        form: this
      });

      if (errorMessages) {
        propsPatch = propsPatch.set('errors', errorMessages);
      }
    }

    /**
     * Get the next validity (valid/invalid) state.
     * Based on the changed fieldProps, the field aquires a new validity state,
     * which means its "valid" and "invalid" props values are updated.
     */
    const nextFieldProps = fieldProps.merge(propsPatch);
    const nextValidityState = fieldUtils.getValidityState({
      fieldProps: nextFieldProps,
      needsValidation
    });

    /* Update the field in the state to reflect the changes */
    return this.updateField({
      fieldProps: nextFieldProps,
      update: fieldProps => fieldProps
        .merge(propsPatch)
        .merge(nextValidityState)
    });
  }

  /**
   * Performs the validation of each field in parallel, awaiting for all the pending
   * validations to be completed.
   * @param {Function} predicate (Optional) Predicate function to filter the fields.
   */
  validate = async (predicate = filterFields) => {
    const { fields } = this.state;
    const flattenedFields = flattenDeep(fields, predicate, true);

    /* Validate only the fields matching the optional selection */
    const validationSequence = flattenedFields.reduce((validations, fieldProps) => {
      return validations.concat(this.validateField({ fieldProps }));
    }, []);

    /* Await for all validation promises to resolve before returning */
    const validatedFields = await Promise.all(validationSequence);

    const isFormValid = !validatedFields.some(({ nextFieldProps }) => {
      return !nextFieldProps.get('expected');
    });

    const { onInvalid } = this.props;

    if (!isFormValid && onInvalid) {
      const { fields: nextFields } = this.state;

      /* Reduce the invalid fields to the ordered Array */
      const invalidFields = List(nextFields.filterNot(fieldProps => fieldProps.get('expected')));

      /* Call custom callback */
      dispatch(onInvalid, {
        fields: nextFields,
        invalidFields,
        form: this
      }, this.context);
    }

    return isFormValid;
  }

  /**
   * Resets all the fields to their initial state upon mounting.
   */
  reset = () => {
    const nextFields = this.state.fields.map(fieldProps => fieldUtils.resetField(fieldProps));

    this.setState({ fields: nextFields }, () => {
      /* Validate only non-empty fields, since empty required fields should not be unexpected on reset */
      this.validate(entry => Map.isMap(entry) && (entry.get('value') !== ''));

      /* Call custom callback methods to be able to reset controlled fields */
      const { onReset } = this.props;
      if (!onReset) return;

      dispatch(onReset, {
        fields: nextFields,
        form: this
      }, this.context);
    });
  }

  /**
   * Serializes the fields' values into a plain Object.
   * @returns {Map|Object}
   */
  serialize = () => {
    const serialized = fieldUtils.serializeFields(this.state.fields);
    return this.context.withImmutable ? serialized : serialized.toJS();
  }

  /**
   * Submits the form.
   * @param {Event} event
   */
  submit = async (event) => {
    if (event) event.preventDefault();

    /* Throw on submit attempt without the "action" prop */
    const { action } = this.props;

    invariant(action, 'Cannot submit the form without `action` prop specified explicitly. Expected a function ' +
      'which returns Promise, but received: %s.', action);

    /* Ensure form has no unexpected fields and, therefore, should be submitted */
    const shouldSubmit = await this.validate();
    if (!shouldSubmit) return;

    const { fields } = this.state;
    const { onSubmitStart, onSubmitted, onSubmitFailed, onSubmitEnd } = this.props;

    /* Serialize the fields */
    const serialized = this.serialize();

    /* Compose a single Object of arguments passed to each custom handler */
    const callbackArgs = {
      serialized,
      fields,
      form: this
    };

    /**
     * Event: Submit has started.
     * The submit is consideres started immediately when the submit button is pressed.
     * This is a good place to have a UI logic dependant on the form submit (i.e. loaders).
     */
    if (onSubmitStart) dispatch(onSubmitStart, callbackArgs, this.context);

    const dispatchedAction = dispatch(action, callbackArgs, this.context);

    invariant(dispatchedAction && (typeof dispatchedAction.then === 'function'), 'Cannot submit the form. ' +
      'Expected `action` prop of the Form to return an instance of Promise, but got: %s. Make sure you return a ' +
      'Promise from your action handler.', dispatchedAction);

    return dispatchedAction.then((res) => {
      if (onSubmitted) dispatch(onSubmitted, { ...callbackArgs, res }, this.context);
      return res;
    }).catch((res) => {
      if (onSubmitFailed) dispatch(onSubmitFailed, { ...callbackArgs, res }, this.context);
      return res;
    }).then((res) => {
      if (onSubmitEnd) dispatch(onSubmitEnd, { ...callbackArgs, res }, this.context);
    });
  }

  render() {
    const { innerRef, id, className, children } = this.props;

    return (
      <form
        ref={ ref => getInnerRef.call(this, ref, innerRef) }
        { ...{ id } }
        { ...{ className } }
        onSubmit={ this.submit }
        noValidate>
        { children }
      </form>
    );
  }
}
