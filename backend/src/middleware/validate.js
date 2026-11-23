/**
 * Generic request validator middleware using Joi schemas
 * @param {Object} schema - Joi schema object with optional body, query, params
 */
const validate = (schema) => (req, res, next) => {
  const validationOptions = {
    abortEarly: false,
    allowUnknown: true,
    stripUnknown: true,
  };

  const toValidate = {};
  if (schema.body) toValidate.body = req.body;
  if (schema.query) toValidate.query = req.query;
  if (schema.params) toValidate.params = req.params;

  for (const [key, joiSchema] of Object.entries(schema)) {
    if (toValidate[key]) {
      const { error, value } = joiSchema.validate(toValidate[key], validationOptions);
      if (error) {
        const errorDetails = error.details.map((detail) => detail.message);
        return res.status(400).json({
          status: 'fail',
          statusCode: 400,
          error: 'Validation Error',
          details: errorDetails,
        });
      }
      req[key] = value;
    }
  }

  return next();
};

module.exports = validate;
