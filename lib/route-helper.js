'use strict';

/**
 * Module dependencies.
 */

var debug = require('debug')('loopback:explorer:routeHelpers');
var _cloneDeep = require('lodash.clonedeep');
var translateDataTypeKeys = require('./translate-data-type-keys');
var modelHelper = require('./model-helper');

/**
 * Export the routeHelper singleton.
 */
var routeHelper = module.exports = {
  /**
   * Given a route, generate an API description and add it to the doc.
   * If a route shares a path with another route (same path, different verb),
   * add it as a new operation under that API description.
   * 
   * Routes can be translated to API declaration 'operations',
   * but they need a little massaging first. The `accepts` and
   * `returns` declarations need some basic conversions to be compatible. 
   *
   * This method will convert the route and add it to the doc.
   * @param  {Route} route    Strong Remoting Route object.
   * @param  {Class} classDef Strong Remoting class.
   * @param  {Object} doc     The class's backing API declaration doc.
   */
  addRouteToAPIDeclaration: function (route, classDef, doc) {
    var api = routeHelper.routeToAPIDoc(route, classDef);
    var matchingAPIs = doc.apis.filter(function(existingAPI) {
      return existingAPI.path === api.path;
    });
    if (matchingAPIs.length) {
      matchingAPIs[0].operations.push(api.operations[0]);
    } else {
      doc.apis.push(api);
    }
  }, 

  /**
   * Massage route.accepts.
   * @param  {Object} route    Strong Remoting Route object.
   * @param  {Class}  classDef Strong Remoting class.
   * @return {Array}           Array of param docs.
   */
  convertAcceptsToSwagger: function convertAcceptsToSwagger(route, classDef) {
    var split = route.method.split('.');
    var accepts = _cloneDeep(route.accepts) || [];
    if (classDef && classDef.sharedCtor && 
        classDef.sharedCtor.accepts && split.length > 2 /* HACK */) {
      accepts = accepts.concat(classDef.sharedCtor.accepts);
    }

    // Filter out parameters that are generated from the incoming request,
    // or generated by functions that use those resources.
    accepts = accepts.filter(function(arg){
      if (!arg.http) return true;
      // Don't show derived arguments.
      if (typeof arg.http === 'function') return false;
      // Don't show arguments set to the incoming http request.
      // Please note that body needs to be shown, such as User.create().
      if (arg.http.source === 'req') return false;
      return true;
    });

    // Translate LDL keys to Swagger keys.
    accepts = accepts.map(translateDataTypeKeys);

    // Turn accept definitions in to parameter docs.
    accepts = accepts.map(routeHelper.acceptToParameter(route));

    return accepts;
  },

  /**
   * Massage route.returns.
   * @param  {Object} route    Strong Remoting Route object.
   * @param  {Class}  classDef Strong Remoting class.
   * @return {Object}          A single returns param doc.
   */
  convertReturnsToSwagger: function convertReturnsToSwagger(route, classDef) {
    var routeReturns = _cloneDeep(route.returns) || [];
    // HACK: makes autogenerated REST routes return the correct model name.
    var firstReturn = routeReturns && routeReturns[0];
    if (firstReturn && firstReturn.arg === 'data') {
      if (firstReturn.type === 'object') {
        firstReturn.type = classDef.name;
      } else if (firstReturn.type === 'array') {
        firstReturn.type = [classDef.name];
      }
    }

    // Translate LDL keys to Swagger keys.
    var returns = routeReturns.map(translateDataTypeKeys);

    // Convert `returns` into a single object for later conversion into an 
    // operation object.
    if (returns && returns.length > 1) {
      // TODO ad-hoc model definition in the case of multiple return values.
      returns = {model: 'object'}; 
    } else {
      returns = returns[0] || {};
    }

    return returns;
  },

  /**
   * Converts from an sl-remoting-formatted "Route" description to a
   * Swagger-formatted "API" description.
   * See https://github.com/wordnik/swagger-spec/blob/master/versions/1.2.md#523-operation-object
   */
  routeToAPIDoc: function routeToAPIDoc(route, classDef) {
    var returnDesc;

    // Some parameters need to be altered; eventually most of this should 
    // be removed.
    var accepts = routeHelper.convertAcceptsToSwagger(route, classDef);
    var returns = routeHelper.convertReturnsToSwagger(route, classDef);

    debug('route %j', route);

    var apiDoc = {
      path: routeHelper.convertPathFragments(route.path),
      // Create the operation doc. Use `extendWithType` to add the necessary
      // `items` and `format` fields.
      operations: [routeHelper.extendWithType({
        method: routeHelper.convertVerb(route.verb),
        // [rfeng] Swagger UI doesn't escape '.' for jQuery selector
        nickname: route.method.replace(/\./g, '_'), 
        // Per the spec:
        // https://github.com/wordnik/swagger-spec/blob/master/versions/1.2.md#523-operation-object
        // This is the only object that may have a type of 'void'.
        type: returns.model || returns.type || 'void',
        parameters: accepts,
        // TODO(schoon) - We don't have descriptions for this yet.
        responseMessages: [], 
        summary: route.description, // TODO(schoon) - Excerpt?
        notes: '' // TODO(schoon) - `description` metadata?
      })]
    };

    return apiDoc;
  },

  convertPathFragments: function convertPathFragments(path) {
    return path.split('/').map(function (fragment) {
      if (fragment.charAt(0) === ':') {
        return '{' + fragment.slice(1) + '}';
      }
      return fragment;
    }).join('/');
  },

  convertVerb: function convertVerb(verb) {
    if (verb.toLowerCase() === 'all') {
      return 'POST';
    }

    if (verb.toLowerCase() === 'del') {
      return 'DELETE';
    }

    return verb.toUpperCase();
  },

  /**
   * A generator to convert from an sl-remoting-formatted "Accepts" description 
   * to a Swagger-formatted "Parameter" description.
   */
  acceptToParameter: function acceptToParameter(route) {
    var type = 'form';

    if (route.verb.toLowerCase() === 'get') {
      type = 'query';
    }

    return function (accepts) {
      var name = accepts.name || accepts.arg;
      var paramType = type;

      // TODO: Regex. This is leaky.
      if (route.path.indexOf(':' + name) !== -1) {
        paramType = 'path';
      }

      // Check the http settings for the argument
      if(accepts.http && accepts.http.source) {
          paramType = accepts.http.source;
      }

      var out = {
        paramType: paramType || type,
        name: name,
        description: accepts.description,
        type: accepts.type,
        required: !!accepts.required,
        defaultValue: accepts.defaultValue,
        minimum: accepts.minimum,
        maximum: accepts.maximum,
        allowMultiple: false
      };

      out = routeHelper.extendWithType(out);

      // HACK: Derive the type from model
      if(out.name === 'data' && out.type === 'object') {
        out.type = route.method.split('.')[0];
      }

      return out;
    };
  },

  /**
   * Extends an Operation Object or Parameter object with 
   * a proper Swagger type and optional `format` and `items` fields.
   * Does not modify original object.
   * @param  {Object} obj Object to extend.
   * @return {Object}     Extended object.
   */
  extendWithType: function extendWithType(obj) {
    obj = _cloneDeep(obj);

    // Format the `type` property using our LDL converter.
    var typeDesc = modelHelper
      .LDLPropToSwaggerDataType({type: obj.model || obj.type});
    // The `typeDesc` may have additional attributes, such as
    // `format` for non-primitive types.
    Object.keys(typeDesc).forEach(function(key){
      obj[key] = typeDesc[key];
    });
    return obj;
  }
};


